/*
 * Схема по выведенным кадрам: пластина идёт по траектории из кода, а за ней выделяется обработанный контур.
 * Деталь слева, резец идёт справа налево. Перенос ToolpathPlot и PlotViewport.
 */
(function (root) {
  'use strict';

  const PASS_MILLIS = 3000;
  const HOLD_AT_END_MILLIS = 900;
  const EDGE_LENGTH = 110;
  const PLOT_HEIGHT = 240;
  const PADDING = 36;
  const MIN_SPAN = 0.001;

  /** Перевод координат детали в пиксели: Z влево, X вверх. Масштаб по осям одинаковый. */
  function fitViewport(points, width, height, padding) {
    let minZ = Infinity, maxZ = -Infinity, minR = Infinity, maxR = -Infinity;
    points.forEach((p) => {
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      minR = Math.min(minR, p.r); maxR = Math.max(maxR, p.r);
    });
    const spanZ = Math.max(maxZ - minZ, MIN_SPAN);
    const spanR = Math.max(maxR - minR, MIN_SPAN);
    const scale = Math.min((width - 2 * padding) / spanZ, (height - 2 * padding) / spanR);
    const offsetX = width / 2 + ((minZ + maxZ) / 2) * scale;
    const offsetY = height / 2 + ((minR + maxR) / 2) * scale;
    return {
      x: (z) => offsetX - z * scale,
      y: (r) => offsetY - r * scale,
    };
  }

  /** Всё, что должно поместиться на схеме: контур, траектория и пластина в обоих концах. */
  function extentPoints(preview) {
    const points = preview.contour.sample().concat(preview.programmed.sample());
    [preview.programmed.start, preview.programmed.end].forEach((tip) => {
      const center = preview.noseCenter(tip);
      points.push({ z: center.z - preview.toolRadius, r: center.r - preview.toolRadius });
      points.push({ z: center.z + preview.toolRadius, r: center.r + preview.toolRadius });
      if (preview.tool.kind === 'parting') points.push(tip);
    });
    return points;
  }

  function readColors() {
    const style = getComputedStyle(document.documentElement);
    const color = (name) => style.getPropertyValue(name).trim();
    return {
      background: color('--background'),
      contour: color('--on-surface'),
      path: color('--secondary'),
      nose: color('--primary'),
      axis: color('--on-surface-variant'),
    };
  }

  function tracePath(ctx, points, viewport) {
    ctx.beginPath();
    points.forEach((point, index) => {
      const x = viewport.x(point.z);
      const y = viewport.y(point.r);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }

  function legendRow(text, color, dashed, thin) {
    const row = document.createElement('div');
    row.className = 'legend';
    const width = thin ? 2 : 3;
    row.innerHTML =
      `<svg width="40" height="12" viewBox="0 0 40 12" aria-hidden="true">` +
      `<line x1="0" y1="6" x2="40" y2="6" stroke="${color}" stroke-width="${width}"` +
      (dashed ? ' stroke-dasharray="10 6"' : '') +
      ' /></svg>';
    const label = document.createElement('span');
    label.textContent = text;
    row.appendChild(label);
    return row;
  }

  class ToolpathPlot {
    constructor(preview) {
      this.preview = preview;
      this.progress = 0;
      this.holding = 0;
      this.isPlaying = true;
      this.lastTime = null;
      this.frame = null;
      this.colors = readColors();

      this.element = document.createElement('div');
      this.element.className = 'plot';

      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute(
        'aria-label',
        'Анимация: пластина движется вдоль контура детали по траектории из кода. Деталь слева, резец идёт справа налево',
      );
      this.element.appendChild(this.canvas);

      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.className = 'button outlined';
      this.button.textContent = 'Пауза';
      this.button.addEventListener('click', () => this.togglePlaying());
      this.element.appendChild(this.button);

      this.legends = document.createElement('div');
      this.legends.className = 'group';
      this.legends.style.gap = '8px';
      this.element.appendChild(this.legends);
      this.renderLegend();

      const note = document.createElement('p');
      note.className = 'note';
      note.textContent =
        'Режет окружность пластины, она должна касаться контура. Условная вершина при этом может идти внутри материала, это нормально. Материал показан условно: соседние участки детали неизвестны.';
      this.element.appendChild(note);

      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(this.canvas);
      this.schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.onScheme = () => {
        this.colors = readColors();
        this.renderLegend();
        this.draw();
      };
      this.schemeQuery.addEventListener('change', this.onScheme);
      this.tick = this.tick.bind(this);
      this.frame = requestAnimationFrame(this.tick);
    }

    renderLegend() {
      const { preview, colors } = this;
      this.legends.replaceChildren(
        legendRow('Контур детали', colors.contour, false, false),
        legendRow('Вершина резца по коду', colors.path, true, false),
      );
      if (preview.toolRadius > 0 || preview.edges || preview.tool.kind === 'parting') {
        this.legends.appendChild(legendRow('Пластина', colors.nose, false, true));
      }
    }

    togglePlaying() {
      this.isPlaying = !this.isPlaying;
      this.button.textContent = this.isPlaying ? 'Пауза' : 'Продолжить';
      this.lastTime = null;
      if (this.isPlaying && this.frame == null) this.frame = requestAnimationFrame(this.tick);
    }

    tick(time) {
      this.frame = null;
      if (!this.isPlaying) return;
      const delta = this.lastTime == null ? 0 : Math.min(time - this.lastTime, 100);
      this.lastTime = time;
      if (this.progress < 1) {
        this.progress = Math.min(1, this.progress + delta / PASS_MILLIS);
      } else {
        this.holding += delta;
        if (this.holding >= HOLD_AT_END_MILLIS) {
          this.holding = 0;
          this.progress = 0;
        }
      }
      this.draw();
      this.frame = requestAnimationFrame(this.tick);
    }

    destroy() {
      if (this.frame != null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.isPlaying = false;
      this.resizeObserver.disconnect();
      this.schemeQuery.removeEventListener('change', this.onScheme);
    }

    draw() {
      const canvas = this.canvas;
      const width = canvas.clientWidth;
      const height = PLOT_HEIGHT;
      if (width === 0) return;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = this.colors.background;
      ctx.fillRect(0, 0, width, height);
      ctx.lineJoin = 'round';

      const { preview, colors } = this;
      const tip = preview.programmed.pointAt(this.progress);
      const contactFraction = preview.contour.nearestFraction(preview.noseCenter(tip));
      const viewport = fitViewport(extentPoints(preview), width, height, PADDING);

      this.drawMaterial(ctx, viewport, width, height);
      this.drawAxisLine(ctx, viewport, width, height);

      // Контур детали: бледный ещё впереди, сплошной уже пройден.
      ctx.setLineDash([]);
      ctx.strokeStyle = colors.contour;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 2;
      tracePath(ctx, preview.contour.sample(), viewport);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 4;
      tracePath(ctx, preview.contour.sampleUpTo(contactFraction), viewport);
      ctx.stroke();

      // Траектория вершины по коду: пунктир со стрелкой направления.
      ctx.strokeStyle = colors.path;
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 8]);
      tracePath(ctx, preview.programmed.sample(), viewport);
      ctx.stroke();
      ctx.setLineDash([]);
      this.drawArrow(ctx, viewport);

      // Пластина и условная вершина в текущем положении.
      const pixelsPerUnit = Math.abs(viewport.x(0) - viewport.x(1));
      const isParting = preview.tool.kind === 'parting';
      if (isParting) {
        const bladeHeight = EDGE_LENGTH / pixelsPerUnit;
        const outline = GCode.partingBladeOutline(tip, preview.tool.width, preview.toolRadius, bladeHeight);
        this.drawBody(ctx, outline, viewport, false);
      }
      if (preview.edges && !isParting) {
        const center = preview.noseCenter(tip);
        const outline = preview.edges.outline(center, preview.toolRadius, EDGE_LENGTH / pixelsPerUnit);
        this.drawBody(ctx, outline, viewport, true);
      }
      if (!isParting && !preview.edges && preview.toolRadius > 0) {
        const center = preview.noseCenter(tip);
        const radius = viewport.y(center.r) - viewport.y(center.r + preview.toolRadius);
        ctx.beginPath();
        ctx.arc(viewport.x(center.z), viewport.y(center.r), radius, 0, 2 * Math.PI);
        ctx.fillStyle = colors.nose;
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = colors.nose;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(viewport.x(tip.z), viewport.y(tip.r), 5, 0, 2 * Math.PI);
      ctx.fillStyle = colors.path;
      ctx.fill();

      // Обозначения осей в правом верхнем углу: там нет ни контура, ни материала.
      const originX = width - 44;
      const originY = 44;
      const length = 28;
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(originX - length, originY);
      ctx.moveTo(originX, originY);
      ctx.lineTo(originX, originY - length);
      ctx.stroke();
      ctx.fillStyle = colors.axis;
      ctx.font = '600 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText('Z+', originX - length - 26, originY - 10);
      ctx.fillText('X+', originX + 6, originY - length);
    }

    drawBody(ctx, outline, viewport, closed) {
      tracePath(ctx, outline, viewport);
      if (closed) ctx.closePath();
      ctx.fillStyle = this.colors.nose;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.colors.nose;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    /**
     * Материал условный: соседние участки детали неизвестны. После конца контура, то есть левее,
     * диаметр продолжается. До начала, правее, либо торец, либо у вогнутого перехода и спада тот же диаметр.
     */
    drawMaterial(ctx, viewport, width, height) {
      const { preview } = this;
      let contour = preview.contour.sample();
      // При обратном ходе контур идёт в другую сторону, а закраска строится по возрастанию Z.
      if (contour[0].z > contour[contour.length - 1].z) contour = contour.slice().reverse();
      const first = contour[0];
      const last = contour[contour.length - 1];
      const bottomY = Math.min(height, viewport.y(0));
      const isParting = preview.tool.kind === 'parting';

      ctx.beginPath();
      ctx.moveTo(viewport.x(first.z), bottomY);
      if (preview.materialBeforeStart) {
        ctx.lineTo(width, bottomY);
        ctx.lineTo(width, viewport.y(first.r));
      }
      ctx.lineTo(viewport.x(first.z), viewport.y(first.r));
      contour.forEach((point) => ctx.lineTo(viewport.x(point.z), viewport.y(point.r)));
      if (!isParting) {
        ctx.lineTo(0, viewport.y(last.r));
        ctx.lineTo(0, bottomY);
      } else {
        // Отрезанная деталь кончается торцом, а пруток начинается за канавкой шириной в резец.
        ctx.lineTo(viewport.x(last.z), bottomY);
      }
      ctx.closePath();
      ctx.fillStyle = this.colors.contour;
      ctx.globalAlpha = 0.14;
      ctx.fill();

      if (isParting) {
        const barStart = viewport.x(last.z + preview.tool.width);
        if (barStart > 0) {
          const top = viewport.y(Math.max(...contour.map((point) => point.r)));
          ctx.fillRect(0, top, barStart, bottomY - top);
        }
      }
      ctx.globalAlpha = 1;
    }

    /** Ось детали показывается, только если попадает на схему. */
    drawAxisLine(ctx, viewport, width, height) {
      const y = viewport.y(0);
      if (y < 0 || y > height) return;
      ctx.strokeStyle = this.colors.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([18, 5, 3, 5]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawArrow(ctx, viewport) {
      const programmed = this.preview.programmed;
      const tipPoint = programmed.pointAt(0.5);
      const before = programmed.pointAt(0.48);
      const tipX = viewport.x(tipPoint.z);
      const tipY = viewport.y(tipPoint.r);
      const angle = Math.atan2(tipY - viewport.y(before.r), tipX - viewport.x(before.z));
      const length = 16;
      const spread = 0.5;
      ctx.strokeStyle = this.colors.path;
      ctx.lineWidth = 3;
      ctx.beginPath();
      [angle + Math.PI - spread, angle + Math.PI + spread].forEach((wing) => {
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX + length * Math.cos(wing), tipY + length * Math.sin(wing));
      });
      ctx.stroke();
    }
  }

  const DROP_MILLIS = 2000;

  /**
   * Сечение поперёк детали, вид со стороны гребёнки: Y вправо, X вверх.
   * Фреза опускается по X рядом с заготовкой, в отведённом положении по Y. Вторая сторона показана пунктиром.
   */
  class RetractSketch {
    constructor(result) {
      this.result = result;
      this.progress = 0;
      this.holding = 0;
      this.isPlaying = true;
      this.lastTime = null;
      this.frame = null;
      this.colors = readColors();

      this.element = document.createElement('div');
      this.element.className = 'plot';
      this.canvas = document.createElement('canvas');
      this.canvas.style.height = '260px';
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'Сечение детали: фреза опускается по X рядом с заготовкой, отведённая по Y');
      this.element.appendChild(this.canvas);

      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.className = 'button outlined';
      this.button.textContent = 'Пауза';
      this.button.addEventListener('click', () => this.togglePlaying());
      this.element.appendChild(this.button);

      this.legends = document.createElement('div');
      this.legends.className = 'group';
      this.legends.style.gap = '8px';
      this.element.appendChild(this.legends);
      this.renderLegend();

      this.resizeObserver = new ResizeObserver(() => this.draw());
      this.resizeObserver.observe(this.canvas);
      this.schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.onScheme = () => {
        this.colors = readColors();
        this.renderLegend();
        this.draw();
      };
      this.schemeQuery.addEventListener('change', this.onScheme);
      this.tick = this.tick.bind(this);
      this.frame = requestAnimationFrame(this.tick);
    }

    renderLegend() {
      const { colors } = this;
      this.legends.replaceChildren(
        legendRow('Заготовка', colors.contour, false, false),
        legendRow('Фреза', colors.nose, false, true),
        legendRow('Отвод по Y от оси детали', colors.path, true, false),
      );
    }

    togglePlaying() {
      ToolpathPlot.prototype.togglePlaying.call(this);
    }

    tick(time) {
      this.frame = null;
      if (!this.isPlaying) return;
      const delta = this.lastTime == null ? 0 : Math.min(time - this.lastTime, 100);
      this.lastTime = time;
      if (this.progress < 1) {
        this.progress = Math.min(1, this.progress + delta / DROP_MILLIS);
      } else {
        this.holding += delta;
        if (this.holding >= HOLD_AT_END_MILLIS) {
          this.holding = 0;
          this.progress = 0;
        }
      }
      this.draw();
      this.frame = requestAnimationFrame(this.tick);
    }

    destroy() {
      ToolpathPlot.prototype.destroy.call(this);
    }

    draw() {
      const canvas = this.canvas;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = this.colors.background;
      ctx.fillRect(0, 0, width, height);
      ctx.lineJoin = 'round';

      const { colors } = this;
      const { stockR, cutterR, centerY, halfWidth } = this.result;
      // Торец фрезы в конце хода; без введённого X она доходит до оси.
      const tipEnd = this.result.depthX == null ? 0 : Math.min(this.result.depthR, stockR + cutterR);
      const tipStart = Math.max(stockR, tipEnd) + Math.max(cutterR, stockR * 0.4);
      const top = tipStart + 2 * cutterR;

      // Масштаб одинаковый по осям, место снизу под размер.
      const left = -(centerY + cutterR);
      const right = centerY + cutterR;
      const bottom = -stockR;
      const pad = 24;
      const dimension = 34;
      const scale = Math.min((width - 2 * pad) / (right - left), (height - 2 * pad - dimension) / (top - bottom));
      const originX = width / 2 - ((left + right) / 2) * scale;
      const originY = pad + top * scale;
      const x = (y) => originX + y * scale;
      const y = (r) => originY - r * scale;

      // Оси детали.
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth = 1;
      ctx.setLineDash([18, 5, 3, 5]);
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(width, y(0));
      ctx.moveTo(x(0), y(top));
      ctx.lineTo(x(0), y(bottom) + 8);
      ctx.stroke();
      ctx.setLineDash([]);

      // Заготовка.
      ctx.beginPath();
      ctx.arc(x(0), y(0), stockR * scale, 0, 2 * Math.PI);
      ctx.fillStyle = colors.contour;
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.contour;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Уровень торца фрезы в конце хода и ширина заготовки на нём.
      if (tipEnd > 0 && tipEnd < stockR) {
        ctx.strokeStyle = colors.axis;
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x(-halfWidth), y(tipEnd));
        ctx.lineTo(x(centerY + cutterR), y(tipEnd));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Отведённое положение с другой стороны: пунктир.
      const cutterTop = y(top) - 4;
      ctx.strokeStyle = colors.nose;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(x(-centerY - cutterR), cutterTop, 2 * cutterR * scale, y(tipEnd) - cutterTop);
      ctx.setLineDash([]);

      // Фреза опускается от начала до конца хода.
      const eased = 1 - Math.pow(1 - this.progress, 2);
      const tip = tipStart + (tipEnd - tipStart) * eased;
      ctx.beginPath();
      ctx.rect(x(centerY - cutterR), cutterTop, 2 * cutterR * scale, y(tip) - cutterTop);
      ctx.fillStyle = colors.nose;
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.nose;
      ctx.lineWidth = 2;
      ctx.stroke();
      // Ось фрезы.
      ctx.strokeStyle = colors.nose;
      ctx.lineWidth = 1;
      ctx.setLineDash([10, 4, 2, 4]);
      ctx.beginPath();
      ctx.moveTo(x(centerY), cutterTop);
      ctx.lineTo(x(centerY), y(tip) + 6);
      ctx.stroke();
      ctx.setLineDash([]);

      // Размер отвода: от оси детали до оси фрезы.
      const dimY = y(bottom) + dimension - 8;
      ctx.strokeStyle = colors.path;
      ctx.fillStyle = colors.path;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(x(centerY), y(tipEnd));
      ctx.lineTo(x(centerY), dimY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x(0), dimY);
      ctx.lineTo(x(centerY), dimY);
      ctx.stroke();
      [[x(0), 1], [x(centerY), -1]].forEach(([px, dir]) => {
        ctx.beginPath();
        ctx.moveTo(px, dimY);
        ctx.lineTo(px + 10 * dir, dimY - 5);
        ctx.lineTo(px + 10 * dir, dimY + 5);
        ctx.closePath();
        ctx.fill();
      });
      ctx.font = '600 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'center';
      ctx.fillText(`${GCode.format(centerY)} мм`, (x(0) + x(centerY)) / 2, dimY - 4);

      // Обозначения осей в левом нижнем углу: сверху стоят фрезы, внизу справа размер.
      const ox = 14;
      const oy = height - 14;
      ctx.strokeStyle = colors.axis;
      ctx.fillStyle = colors.axis;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + 28, oy);
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox, oy - 28);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText('Y+', ox + 32, oy - 8);
      ctx.fillText('X+', ox + 6, oy - 34);
    }
  }

  root.ToolpathPlot = ToolpathPlot;
  root.RetractSketch = RetractSketch;
})(window);
