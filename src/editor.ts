import { generateLevel } from './generator';
import { GRID_STEP, nearestIndex, waterRegions, type LevelData, type Point } from './levelData';
import { EditableLevel, insertLinePoint, nearestLinePoint, nearestObject, type Brush, type GridRect, type StrokeTool } from './levelEditing';
import { decodeLevel, encodeLevel } from './levelFile';
import { OBJECT_TYPES } from './objects';
import { SURFACE_LIST, SURFACES, surfaceId, type Surface } from './surfaces';

type ToolId =
  | 'raise'
  | 'lower'
  | 'smooth'
  | 'flatten'
  | 'set'
  | 'surface'
  | 'wind'
  | 'water'
  | 'tee'
  | 'cup'
  | 'line'
  | 'place'
  | 'move'
  | 'rotate'
  | 'delete'
  | 'scatter';

/** Tools that paint with a brush, and which brush controls they show. */
const BRUSH_TOOLS: Partial<Record<ToolId, { strength?: string; falloff?: boolean }>> = {
  raise: { strength: 'Strength', falloff: true },
  lower: { strength: 'Strength', falloff: true },
  smooth: { strength: 'Strength', falloff: true },
  flatten: { strength: 'Strength', falloff: true },
  set: { strength: 'Strength', falloff: true },
  surface: {},
  wind: {},
  scatter: { strength: 'Density' },
};

const HINTS: Partial<Record<ToolId, string>> = {
  flatten: 'Pulls the ground to the height where the stroke starts.',
  water: 'Paint water with the Surface tool, then click it here to set its level.',
  tee: 'Click or drag to place the tee.',
  cup: 'Click or drag to place the cup.',
  line: 'The camera and distance follow this line from tee to cup. Click to add a point, drag one to move it, Shift-click to delete.',
  place: 'Click to place an object.',
  move: 'Drag an object to move it.',
  rotate: 'Drag around an object to turn it.',
  delete: 'Click an object to delete it.',
};

/** Pointer distance (px) within which a click picks a marker or object. */
const PICK_PX = 10;
/** Colors for wind zones 1, 2, … on the map (zone 0, the default, is left untinted). */
const ZONE_COLORS = [0xe8505b, 0x4f9df7, 0xf7c94f, 0xa66cf0, 0x4fe0c1, 0xf78a4f, 0xd65cc4, 0x9be34f];
/** The map shows water and out-of-bounds ground in their own colors, so they stand out from rough. */
const MAP_COLORS: Partial<Record<Surface, number>> = { water: 0x2f6fa8, oob: 0x6a6f68 };
/** Contour lines every this many meters, with a stronger one every fifth. */
const CONTOUR = 1;

export interface EditorHost {
  /** Plays the level in 3D; the host returns with `show()` when the player is done. */
  playTest(data: LevelData): void;
  /** Leaves the editor. */
  exit(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** The level editor: a top-down map of the level with tools to shape and paint it. */
export class Editor {
  private level: EditableLevel | null = null;
  private savedVersion = 0;
  private tool: ToolId = 'raise';
  private brush: Brush = { radius: 8, strength: 0.5, falloff: 0.5 };
  private setHeight = 0;
  private surface: Surface = 'fairway';
  private zone = 1;
  private waterLevel = 0;
  private objectType = Object.keys(OBJECT_TYPES)[0];

  private readonly root = $('editor');
  private readonly canvas = $<HTMLCanvasElement>('editor-canvas');
  private readonly ctx = this.canvas.getContext('2d')!;
  private readonly options = $('editor-options');
  private readonly status = $('editor-status');
  private readonly nameInput = $<HTMLInputElement>('editor-name');
  private readonly parInput = $<HTMLInputElement>('editor-par');
  private readonly newDialog = $<HTMLDialogElement>('editor-new-dialog');
  private readonly fileInput = $<HTMLInputElement>('editor-file');

  /** The grid drawn one pixel per point, shaded by height and colored by surface. */
  private map = document.createElement('canvas');
  private mapImage: ImageData | null = null;
  /** World → screen: screen = world * scale + offset (CSS pixels). */
  private view = { scale: 1, x: 0, y: 0 };
  private pointer: { x: number; z: number; sx: number; sy: number } | null = null;
  private drag: { mode: 'tool' | 'pan'; id: number; sx: number; sy: number; target: number } | null = null;
  private spaceDown = false;
  private drawQueued = false;
  /** Water regions for the status bar, recomputed when the level changes. */
  private water: { version: number; regions: ReturnType<typeof waterRegions> } | null = null;

  constructor(private readonly host: EditorHost) {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.addEventListener('click', () => this.selectTool(button.dataset.tool as ToolId));
    }
    $('editor-undo').addEventListener('click', () => this.applyHistory('undo'));
    $('editor-redo').addEventListener('click', () => this.applyHistory('redo'));
    $('editor-new').addEventListener('click', () => this.confirmDiscard() && this.showNewDialog());
    $('editor-open').addEventListener('click', () => this.confirmDiscard() && this.fileInput.click());
    $('editor-save').addEventListener('click', () => this.save());
    // Play a copy, so the hole being played never shares grids with the level being edited.
    $('editor-play').addEventListener('click', () => this.level && this.host.playTest(structuredClone(this.level.data)));
    // The level stays open while you're away, so leaving loses nothing.
    $('editor-exit').addEventListener('click', () => this.close());
    this.nameInput.addEventListener('change', () => this.level?.change((d) => (d.name = this.nameInput.value.trim() || 'Untitled')));
    this.parInput.addEventListener('change', () => {
      const par = Math.round(Number(this.parInput.value));
      if (par >= 1) this.level?.change((d) => (d.par = par));
      this.syncBar();
    });
    this.fileInput.addEventListener('change', () => this.openFile());

    $('new-blank').addEventListener('click', () => {
      const width = clampInput($<HTMLInputElement>('new-width'), 40, 1000);
      const length = clampInput($<HTMLInputElement>('new-length'), 40, 3000);
      this.newDialog.close();
      this.load(EditableLevel.blank(width, length));
    });
    $('new-random').addEventListener('click', () => {
      const seed = Math.floor(Number($<HTMLInputElement>('new-seed').value)) >>> 0;
      this.newDialog.close();
      this.load(new EditableLevel(generateLevel(seed)));
    });
    // Closing the first dialog with nothing to edit leaves the editor.
    this.newDialog.addEventListener('close', () => !this.level && this.close());

    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.updateStatus();
      this.requestDraw();
    });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('resize', () => this.visible && this.resize());
    this.selectTool('raise');
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Shows the editor: the level being edited, or the new-level dialog if there isn't one. */
  show(): void {
    this.root.hidden = false;
    this.resize();
    if (!this.level) this.showNewDialog();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private close(): void {
    this.hide();
    this.host.exit();
  }

  private load(level: EditableLevel): void {
    this.level = level;
    this.savedVersion = level.version;
    this.water = null;
    this.map.width = level.cols;
    this.map.height = level.rows;
    this.mapImage = new ImageData(level.cols, level.rows);
    this.paintMap();
    this.syncBar();
    this.buildOptions();
    this.updateStatus();
    this.fit();
  }

  private showNewDialog(): void {
    $<HTMLInputElement>('new-seed').value = String(Math.floor(Math.random() * 1e6));
    this.newDialog.showModal();
  }

  private confirmDiscard(): boolean {
    return !this.level || this.level.version === this.savedVersion || confirm('Discard unsaved changes to this level?');
  }

  private async openFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = '';
    if (!file) return;
    try {
      this.load(new EditableLevel(await decodeLevel(JSON.parse(await file.text()))));
    } catch (err) {
      alert(`${file.name}: ${err instanceof Error ? err.message : 'Not a level file'}`);
    }
  }

  private async save(): Promise<void> {
    if (!this.level) return;
    const data = this.level.data;
    const version = this.level.version;
    const blob = new Blob([await encodeLevel(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'level'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.savedVersion = version;
  }

  private applyHistory(kind: 'undo' | 'redo'): void {
    // Not mid-stroke or mid-drag: the step being made isn't finished yet.
    if (!this.level || this.drag || !this.level[kind]()) return;
    this.paintMap();
    this.syncBar();
    this.buildOptions();
  }

  // --- Tools ---------------------------------------------------------------------

  private selectTool(tool: ToolId): void {
    this.tool = tool;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      button.classList.toggle('active', button.dataset.tool === tool);
    }
    this.buildOptions();
    // The map tints wind zones only while the wind tool is out.
    this.paintMap();
  }

  /** Rebuilds the options panel for the current tool. */
  private buildOptions(): void {
    // The zone being painted may have been removed (or undone away).
    if (this.level) this.zone = Math.min(this.zone, this.level.data.winds.length - 1);
    const o = this.options;
    o.replaceChildren();
    const brush = BRUSH_TOOLS[this.tool];
    if (brush) {
      o.append(slider('Radius', 1, 60, 1, this.brush.radius, ' m', (v) => (this.brush.radius = v)));
      if (brush.strength) o.append(slider(brush.strength, 0.05, 1, 0.05, this.brush.strength, '', (v) => (this.brush.strength = v)));
      if (brush.falloff) o.append(slider('Falloff', 0, 1, 0.05, this.brush.falloff, '', (v) => (this.brush.falloff = v)));
    }
    if (this.tool === 'set') o.append(numberRow('Height (m)', this.setHeight, 0.1, (v) => (this.setHeight = v)));
    if (this.tool === 'surface') o.append(this.surfacePicker());
    if (this.tool === 'wind') o.append(...this.windEditor());
    if (this.tool === 'water') o.append(numberRow('Water level (m)', this.waterLevel, 0.05, (v) => (this.waterLevel = v)));
    if (this.tool === 'place' || this.tool === 'scatter') {
      o.append(selectRow('Object', Object.keys(OBJECT_TYPES), this.objectType, (v) => (this.objectType = v)));
    }
    const hint = HINTS[this.tool];
    if (hint) o.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: hint }));
  }

  private surfacePicker(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'swatches';
    for (const s of SURFACE_LIST) {
      const button = document.createElement('button');
      button.type = 'button';
      button.classList.toggle('active', s === this.surface);
      const swatch = Object.assign(document.createElement('span'), { className: 'swatch' });
      swatch.style.background = css(surfaceColor(s));
      button.append(swatch, s === 'oob' ? 'Out of bounds' : s[0].toUpperCase() + s.slice(1));
      button.addEventListener('click', () => {
        this.surface = s;
        this.buildOptions();
      });
      wrap.append(button);
    }
    return wrap;
  }

  /** Zone picker plus each zone's wind; zone 0 is the default wind everywhere unpainted. */
  private windEditor(): HTMLElement[] {
    const level = this.level;
    if (!level) return [];
    const rows: HTMLElement[] = [];
    level.data.winds.forEach((w, i) => {
      const zone = document.createElement('div');
      zone.className = 'zone';
      const row = document.createElement('div');
      row.className = 'row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = i === this.zone ? '' : 'secondary';
      if (i > 0) {
        const swatch = Object.assign(document.createElement('span'), { className: 'swatch' });
        swatch.style.background = css(ZONE_COLORS[(i - 1) % ZONE_COLORS.length]);
        pick.append(swatch);
      }
      pick.append(i === 0 ? 'Default' : `Zone ${i}`);
      pick.title = 'Paint with this zone';
      pick.addEventListener('click', () => {
        this.zone = i;
        this.buildOptions();
      });
      const speed = numberInput(w.speed, 0.5, (v) => level.change((d) => (d.winds[i].speed = Math.max(0, v))));
      speed.title = 'Speed (m/s)';
      const direction = numberInput(w.direction, 15, (v) => level.change((d) => (d.winds[i].direction = ((v % 360) + 360) % 360)));
      direction.title = 'Direction the wind blows toward (degrees; 0 is +x, 90 is down the map)';
      row.append(speed, 'm/s', direction, '°');
      zone.append(pick, row);
      rows.push(zone);
    });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'secondary', textContent: 'Add zone' });
    add.addEventListener('click', () => {
      level.change((d) => d.winds.push({ speed: 3, direction: 0 }));
      this.zone = level.data.winds.length - 1;
      this.buildOptions();
    });
    rows.push(add);
    if (level.data.winds.length > 1) {
      const remove = Object.assign(document.createElement('button'), {
        type: 'button',
        className: 'secondary',
        textContent: `Remove zone ${level.data.winds.length - 1}`,
      });
      remove.title = 'Its ground goes back to the default wind';
      remove.addEventListener('click', () => {
        level.removeWindZone();
        this.paintMap();
        this.buildOptions();
      });
      rows.push(remove);
    }
    rows.push(
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent:
          level.data.winds.length > 1
            ? 'Speed in m/s; direction the wind blows toward, in degrees (0 points right, 90 down).'
            : 'Add a zone to paint a different wind somewhere. Speed in m/s; direction in degrees (0 points right, 90 down).',
      }),
    );
    return rows;
  }

  private strokeTool(): StrokeTool | null {
    switch (this.tool) {
      case 'raise':
      case 'lower':
      case 'smooth':
      case 'flatten':
        return { kind: this.tool };
      case 'set':
        return { kind: 'set', height: this.setHeight };
      case 'surface':
        return { kind: 'surface', surface: this.surface };
      case 'wind':
        return { kind: 'wind', zone: this.zone };
      case 'scatter':
        return { kind: 'scatter', type: this.objectType };
      default:
        return null;
    }
  }

  // --- Input ---------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const level = this.level;
    if (!level || this.drag) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.updatePointer(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      this.drag = { mode: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, target: -1 };
      return;
    }
    if (e.button !== 0) return;
    const { x, z } = this.onMap(this.pointer!);
    const pick = PICK_PX / this.view.scale;
    let target = -1;
    const stroke = this.strokeTool();
    if (stroke) {
      const p = this.pointer!;
      level.beginStroke(stroke, { ...this.brush }, p.x, p.z);
      this.afterDab(level.dab(p.x, p.z));
    } else if (this.tool === 'water') {
      if (!level.setWaterLevel(x, z, this.waterLevel)) this.showStatus('No water there: paint some with the Surface tool first.');
      return;
    } else if (this.tool === 'tee' || this.tool === 'cup') {
      level.beginChange();
      level.data[this.tool] = { x, z };
    } else if (this.tool === 'line') {
      target = nearestLinePoint(level.data, x, z, pick);
      if (target >= 0 && e.shiftKey) {
        level.change((d) => d.lineOfPlay!.splice(target, 1));
        return;
      }
      level.beginChange();
      if (target < 0) {
        insertLinePoint(level.data, { x, z });
        target = nearestLinePoint(level.data, x, z, 0.001);
      }
    } else if (this.tool === 'place') {
      level.change((d) => d.objects.push({ type: this.objectType, x, z, rotation: 0, scale: 1 }));
      return;
    } else {
      target = nearestObject(level.data, x, z, Math.max(pick, 3));
      if (target < 0) return;
      if (this.tool === 'delete') {
        level.change((d) => d.objects.splice(target, 1));
        return;
      }
      level.beginChange();
    }
    this.drag = { mode: 'tool', id: e.pointerId, sx: e.clientX, sy: e.clientY, target };
    this.requestDraw();
  }

  private onPointerMove(e: PointerEvent): void {
    this.updatePointer(e);
    const drag = this.drag;
    const level = this.level;
    if (drag && drag.id === e.pointerId && level) {
      const { x, z } = this.onMap(this.pointer!);
      if (drag.mode === 'pan') {
        this.view.x += e.clientX - drag.sx;
        this.view.y += e.clientY - drag.sy;
        drag.sx = e.clientX;
        drag.sy = e.clientY;
      } else if (this.strokeTool()) {
        // Brushes follow the pointer even off the map edge, so strokes can paint right up to it.
        this.afterDab(level.dab(this.pointer!.x, this.pointer!.z));
      } else if (this.tool === 'tee' || this.tool === 'cup') {
        level.data[this.tool] = { x, z };
      } else if (this.tool === 'line') {
        level.data.lineOfPlay![drag.target] = { x, z };
      } else if (this.tool === 'move') {
        Object.assign(level.data.objects[drag.target], { x, z });
      } else if (this.tool === 'rotate') {
        const o = level.data.objects[drag.target];
        o.rotation = Math.round(((Math.atan2(z - o.z, x - o.x) * 180) / Math.PI + 360) % 360);
      }
    }
    this.updateStatus();
    this.requestDraw();
  }

  private onPointerUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.id !== e.pointerId) return;
    this.drag = null;
    const level = this.level;
    if (drag.mode === 'tool' && level) {
      if (this.strokeTool()) level.endStroke();
      else level.endChange();
    }
    this.requestDraw();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    const v = this.view;
    const scale = Math.min(40, Math.max(0.05, v.scale * factor));
    // Zoom about the cursor.
    v.x = e.offsetX - ((e.offsetX - v.x) * scale) / v.scale;
    v.y = e.offsetY - ((e.offsetY - v.y) * scale) / v.scale;
    v.scale = scale;
    this.requestDraw();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.visible || this.newDialog.open) return;
    if (e.key === ' ' && !isTyping(e)) {
      this.spaceDown = down;
      e.preventDefault();
    }
    if (!down || isTyping(e)) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === 'z' || key === 'y')) {
      e.preventDefault();
      this.applyHistory(key === 'y' || e.shiftKey ? 'redo' : 'undo');
    }
  }

  /** A point clamped onto the map, for markers and objects. */
  private onMap(p: Point): Point {
    const { width, length } = this.level!.data;
    return { x: Math.min(width, Math.max(0, p.x)), z: Math.min(length, Math.max(0, p.z)) };
  }

  private updatePointer(e: PointerEvent): void {
    const v = this.view;
    this.pointer = { sx: e.offsetX, sy: e.offsetY, x: (e.offsetX - v.x) / v.scale, z: (e.offsetY - v.y) / v.scale };
  }

  private afterDab(rect: GridRect | null): void {
    if (rect) this.paintMap(rect);
    this.requestDraw();
  }

  // --- Status bar ---------------------------------------------------------------

  private updateStatus(): void {
    const level = this.level;
    const p = this.pointer;
    if (!level || !p || p.x < 0 || p.z < 0 || p.x > level.data.width || p.z > level.data.length) {
      this.status.textContent = 'Drag to use the tool · Right-drag or Space-drag to pan · Scroll to zoom · Ctrl+Z to undo';
      return;
    }
    const i = nearestIndex(level.cols, level.rows, p.x, p.z);
    const g = level.data.grids;
    const parts = [
      `x ${p.x.toFixed(1)}  z ${p.z.toFixed(1)}`,
      `height ${g.height[i].toFixed(2)} m`,
      SURFACE_LIST[g.surface[i]],
      g.wind[i] ? `wind zone ${g.wind[i]}` : 'default wind',
    ];
    if (SURFACE_LIST[g.surface[i]] === 'water') {
      if (this.water?.version !== level.version) this.water = { version: level.version, regions: waterRegions(level.data) };
      const id = this.water.regions.region[i];
      if (id >= 0) parts.push(`water level ${this.water.regions.levels[id].toFixed(2)} m`);
    }
    this.status.textContent = parts.join(' · ');
  }

  private showStatus(message: string): void {
    this.status.textContent = message;
  }

  private syncBar(): void {
    if (!this.level) return;
    this.nameInput.value = this.level.data.name;
    this.parInput.value = String(this.level.data.par);
  }

  // --- Drawing -------------------------------------------------------------------

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.requestDraw();
  }

  /** Fits the whole map in the space between the panels. */
  private fit(): void {
    if (!this.level) return;
    const margin = 16;
    const left = $('editor-side').getBoundingClientRect().right + margin;
    const top = $('editor-bar').getBoundingClientRect().bottom + margin;
    const bottom = this.status.getBoundingClientRect().top - margin;
    const w = Math.max(100, this.canvas.clientWidth - left - margin);
    const h = Math.max(100, bottom - top);
    const { width, length } = this.level.data;
    const scale = Math.min(w / width, h / length);
    this.view = { scale, x: left + (w - width * scale) / 2, y: top + (h - length * scale) / 2 };
    this.requestDraw();
  }

  /** Recolors the map image over `rect` (or all of it), one pixel per grid point. */
  private paintMap(rect?: GridRect): void {
    const level = this.level;
    const image = this.mapImage;
    if (!level || !image) return;
    const { cols, rows } = level;
    const { height, surface, wind } = level.data.grids;
    // Shading reads neighbors, so recolor one point beyond the change.
    const c0 = Math.max(0, (rect?.c0 ?? 0) - 1);
    const r0 = Math.max(0, (rect?.r0 ?? 0) - 1);
    const c1 = Math.min(cols - 1, (rect?.c1 ?? cols) + 1);
    const r1 = Math.min(rows - 1, (rect?.r1 ?? rows) + 1);
    const palette = SURFACE_LIST.map((s) => rgb(surfaceColor(s)));
    const zones = ZONE_COLORS.map(rgb);
    const showZones = this.tool === 'wind';
    const water = surfaceId('water');
    const px = image.data;
    // Light from the top left (-x, -z), high in the sky.
    const lx = -0.5;
    const ly = 0.75;
    const lz = -0.5;
    const at = (c: number, r: number) => height[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const h = height[i];
        const gx = (at(c + 1, r) - at(c - 1, r)) / (2 * GRID_STEP);
        const gz = (at(c, r + 1) - at(c, r - 1)) / (2 * GRID_STEP);
        const shade = Math.max(0.35, Math.min(1.25, (0.45 + (-gx * lx + ly - gz * lz) / Math.hypot(gx, 1, gz)) * 0.95));
        let [red, green, blue] = palette[surface[i]];
        if (showZones && wind[i] > 0) [red, green, blue] = mix([red, green, blue], zones[(wind[i] - 1) % zones.length], 0.45);
        // Contours where a CONTOUR step falls between this point and the next one right or down.
        const band = Math.floor(h / CONTOUR);
        const contour = (n: number) => {
          const b = Math.floor(n / CONTOUR);
          if (b === band) return 1;
          return Math.max(b, band) % 5 === 0 ? 0.78 : 0.9;
        };
        const line = surface[i] === water ? 1 : Math.min(contour(at(c + 1, r)), contour(at(c, r + 1)));
        const k = shade * line;
        const o = i * 4;
        px[o] = Math.min(255, red * k);
        px[o + 1] = Math.min(255, green * k);
        px[o + 2] = Math.min(255, blue * k);
        px[o + 3] = 255;
      }
    }
    this.map.getContext('2d')!.putImageData(image, 0, 0, c0, r0, c1 - c0 + 1, r1 - r0 + 1);
    this.requestDraw();
  }

  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    const { ctx, canvas, level } = this;
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1a10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!level) return;
    const v = this.view;
    const s = v.scale;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * v.x, dpr * v.y);
    const px = 1 / s;
    ctx.imageSmoothingEnabled = s < GRID_STEP * 2;
    // Each pixel is a grid point, so it covers the half step either side of it.
    ctx.drawImage(this.map, -GRID_STEP / 2, -GRID_STEP / 2, level.cols * GRID_STEP, level.rows * GRID_STEP);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = px;
    ctx.strokeRect(0, 0, level.data.width, level.data.length);

    const d = level.data;
    // Objects, as their canopies from above.
    for (const o of d.objects) {
      const def = OBJECT_TYPES[o.type];
      const r = (def?.canopyRadius ?? 1) * o.scale;
      ctx.beginPath();
      ctx.arc(o.x, o.z, r, 0, Math.PI * 2);
      ctx.fillStyle = def ? (def.shape === 'pine' ? 'rgba(20,60,30,0.75)' : 'rgba(45,95,35,0.75)') : 'rgba(220,40,40,0.75)';
      ctx.fill();
      const a = (o.rotation * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(o.x, o.z);
      ctx.lineTo(o.x + Math.cos(a) * r, o.z + Math.sin(a) * r);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = px;
      ctx.stroke();
    }

    // Line of play, tee to cup.
    const route: Point[] = [d.tee, ...(d.lineOfPlay ?? []), d.cup];
    ctx.beginPath();
    route.forEach((p, i) => (i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)));
    ctx.setLineDash([6 * px, 5 * px]);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5 * px;
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of d.lineOfPlay ?? []) dot(ctx, p, 4 * px, '#ffffff');
    dot(ctx, d.tee, 6 * px, '#2b6fd6');
    dot(ctx, d.cup, 6 * px, '#e0262b');

    // Brush outline.
    const p = this.pointer;
    if (p && BRUSH_TOOLS[this.tool] && !(this.drag?.mode === 'pan')) {
      ctx.beginPath();
      ctx.arc(p.x, p.z, this.brush.radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
    }
  }
}

// --- Small helpers --------------------------------------------------------------

function surfaceColor(s: Surface): number {
  return MAP_COLORS[s] ?? SURFACES[s].color;
}

function rgb(color: number): [number, number, number] {
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function dot(ctx: CanvasRenderingContext2D, p: Point, r: number, fill: string): void {
  ctx.beginPath();
  ctx.arc(p.x, p.z, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = r / 3;
  ctx.stroke();
}

function isTyping(e: KeyboardEvent): boolean {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
}

function clampInput(input: HTMLInputElement, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(input.value) || min));
}

function slider(label: string, min: number, max: number, step: number, value: number, unit: string, set: (v: number) => void): HTMLElement {
  const wrap = document.createElement('label');
  const text = document.createElement('div');
  text.className = 'row';
  const shown = document.createElement('span');
  const show = (v: number) => (shown.textContent = `${Number.isInteger(step) ? v : v.toFixed(2)}${unit}`);
  show(value);
  text.append(label, shown);
  const input = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.addEventListener('input', () => {
    set(Number(input.value));
    show(Number(input.value));
  });
  wrap.append(text, input);
  return wrap;
}

function numberInput(value: number, step: number, set: (v: number) => void): HTMLInputElement {
  const input = Object.assign(document.createElement('input'), { type: 'number', step: String(step) });
  input.value = String(Math.round(value * 100) / 100);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) set(v);
  });
  return input;
}

function numberRow(label: string, value: number, step: number, set: (v: number) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'row';
  row.append(label, numberInput(value, step, set));
  return row;
}

function selectRow(label: string, options: string[], value: string, set: (v: string) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'row';
  const select = document.createElement('select');
  for (const o of options) select.append(Object.assign(document.createElement('option'), { value: o, textContent: o }));
  select.value = value;
  select.addEventListener('change', () => set(select.value));
  row.append(label, select);
  return row;
}
