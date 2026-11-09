/*
 * Расчёт G-кода: перенос модуля core/gcode Android-приложения один в один.
 * Координаты, проверки, предупреждения и текст кадров совпадают с Kotlin-версией.
 *
 * Обычный скрипт, а не ES-модуль: так страница открывается и с диска (file://),
 * а в Node этот же файл подключается через require для тестов.
 */
(function (root) {
  'use strict';

  const TOLERANCE = 0.001;
  const EPSILON = 1e-9;
  const FACE_ANGLE = 90.0;

  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const toDegrees = (radians) => (radians * 180) / Math.PI;

  // ---------------------------------------------------------------- Точки

  /** Точка в плоскости расчёта: Z и радиус, а не диаметр. */
  const pt = (z, r) => ({ z, r });
  const add = (a, b) => pt(a.z + b.z, a.r + b.r);
  const sub = (a, b) => pt(a.z - b.z, a.r - b.r);
  const mul = (a, factor) => pt(a.z * factor, a.r * factor);
  const len = (a) => Math.hypot(a.z, a.r);

  /** Переход от центра пластины к условной вершине. */
  const tipOffset = (toolRadius) => pt(toolRadius, -toolRadius);

  // ---------------------------------------------------------------- Формат чисел

  /** Десятичная запись числа без экспоненты: 1e-7 → "0.0000001". */
  function plainDecimal(text) {
    const match = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
    if (!match) return text;
    const digits = match[1] + (match[2] || '');
    const point = match[1].length + Number(match[3]);
    if (point <= 0) return '0.' + '0'.repeat(-point) + digits;
    if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
    return digits.slice(0, point) + '.' + digits.slice(point);
  }

  /**
   * Десятичная точка обязательна: без неё Fanuc при стандартных настройках
   * читает X10 как 0.010 мм, а не как 10 мм.
   * Округление как у BigDecimal.valueOf(value).setScale(3, HALF_UP).stripTrailingZeros().
   */
  function format(value) {
    let text = String(value);
    let negative = false;
    if (text[0] === '-') {
      negative = true;
      text = text.slice(1);
    }
    text = plainDecimal(text);
    let [whole, fraction = ''] = text.split('.');
    let units = BigInt(whole + (fraction + '000').slice(0, 3));
    if (fraction.length > 3 && fraction[3] >= '5') units += 1n;
    if (units === 0n) return '0.0';
    let digits = units.toString().padStart(4, '0');
    whole = digits.slice(0, -3);
    fraction = digits.slice(-3).replace(/0+$/, '');
    return (negative ? '-' : '') + whole + '.' + (fraction || '0');
  }

  // ---------------------------------------------------------------- Ввод чисел

  const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?$/;

  /** Пустое поле это null: значение не задано. Запятая допускается: её даёт русская клавиатура. */
  function parseNumber(text) {
    const cleaned = String(text).trim().replace(/,/g, '.');
    if (!NUMBER.test(cleaned)) return null;
    const value = parseFloat(cleaned);
    return Number.isFinite(value) ? value : null;
  }

  const isInvalidNumber = (text) => String(text).trim() !== '' && parseNumber(text) === null;

  // ---------------------------------------------------------------- Пластины ISO 1832

  const NOSE_ANGLES = {
    A: 85, B: 82, C: 80, D: 55, E: 75, F: 50, H: 120, K: 55,
    L: 90, M: 86, O: 135, P: 108, S: 90, T: 60, V: 35, W: 80,
  };
  const CLEARANCE_ANGLES = { A: 3, B: 5, C: 7, D: 15, E: 20, F: 25, G: 30, N: 0, P: 11 };

  /** Обозначение часто набирают русскими буквами: СМТ вместо CMT. */
  const CYRILLIC_TO_LATIN = {
    'А': 'A', 'В': 'B', 'Д': 'D', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O',
    'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  };

  const LETTERS_ONLY = /^[A-Z]{4}$/;
  /** DCMT11T304, CCGT09T302FN, RCMT0602M0. После радиуса может идти стружколом производителя. */
  const METRIC = /^([A-Z]{4})(\d{2})([0-9T]\d)(\d{2}|M0).*$/;
  /** Дюймовое DCMT21.51: последняя цифра это радиус в 1/64 дюйма. */
  const INCH = /^([A-Z]{4})\d\d\.\d(\d).*$/;
  const INCH_RADIUS_STEP = 0.4;

  function normalizeCode(text, keepDot) {
    const allowed = keepDot ? /[\p{L}\p{Nd}.]/u : /[\p{L}\p{Nd}]/u;
    return Array.from(String(text).toUpperCase())
      .map((ch) => CYRILLIC_TO_LATIN[ch] || ch)
      .filter((ch) => allowed.test(ch))
      .join('');
  }

  function specOf(letters, code, noseRadius) {
    const shape = letters[0];
    if (shape !== 'R' && !(shape in NOSE_ANGLES)) return null;
    return {
      code,
      shape,
      /** null у круглой пластины: вершины у неё нет. */
      noseAngle: shape in NOSE_ANGLES ? NOSE_ANGLES[shape] : null,
      clearanceAngle: letters[1] in CLEARANCE_ANGLES ? CLEARANCE_ANGLES[letters[1]] : null,
      /** null, если указаны только буквы, например DCMT без размеров. */
      noseRadius,
    };
  }

  function parseInsert(text) {
    const code = normalizeCode(text, true);
    if (LETTERS_ONLY.test(code)) return specOf(code, code, null);
    let match = METRIC.exec(code);
    if (match) {
      const [, letters, size, , radius] = match;
      let noseRadius;
      if (letters[0] === 'R') noseRadius = parseInt(size, 10) / 2;
      else if (radius === 'M0') return null;
      else noseRadius = parseInt(radius, 10) / 10;
      return specOf(letters, code, noseRadius);
    }
    match = INCH.exec(code);
    if (match) return specOf(match[1], code, parseInt(match[2], 10) * INCH_RADIUS_STEP);
    return null;
  }

  /** Типовой угол в плане державки под форму пластины: SCLCR 95°, SDJCR и SVJBR 93°. */
  function typicalLeadAngle(shape) {
    if (shape === 'C') return 95;
    if (shape === 'D' || shape === 'V') return 93;
    return null;
  }

  /** Отрезная пластина, например MGMN200 или MRMN300: три цифры это ширина в сотых долях миллиметра. */
  const PARTING = /^[A-Z]{3,4}(\d)(\d{2}).*$/;

  function parsePartingWidth(text) {
    const match = PARTING.exec(normalizeCode(text, false));
    if (!match) return null;
    const width = parseInt(match[1], 10) + parseInt(match[2], 10) / 100;
    return width > 0 ? width : null;
  }

  /** Запас до задней кромки: при меньшем зазоре она трёт деталь, даже если формально не режет. */
  const EDGE_MARGIN_DEGREES = 2.0;
  const OUTLINE_ARC_STEPS = 16;

  /** Кромки пластины в державке. Угол контура считается от оси Z: плюс, если X растёт по ходу резания. */
  class ToolEdges {
    constructor(leadAngle, noseAngle) {
      this.leadAngle = leadAngle;
      this.noseAngle = noseAngle;
    }

    get trailingAngle() {
      return 180 - this.leadAngle - this.noseAngle;
    }

    get isPossible() {
      return this.leadAngle > 0 && this.noseAngle > 0 && this.trailingAngle >= 0;
    }

    get maxFallingAngle() {
      return this.trailingAngle - EDGE_MARGIN_DEGREES;
    }

    cutsWithTrailingEdge(contourAngle) {
      return contourAngle < -this.maxFallingAngle;
    }

    cutsWithLeadEdge(contourAngle) {
      return contourAngle > this.leadAngle;
    }

    /** Контур пластины: задняя кромка, дуга при вершине и главная кромка. */
    outline(center, radius, edgeLength) {
      const contact = (degrees) => {
        const angle = toRadians(degrees);
        return pt(center.z + radius * Math.sin(angle), center.r - radius * Math.cos(angle));
      };
      const trailing = toRadians(-this.trailingAngle);
      const lead = toRadians(this.leadAngle);
      const arc = [];
      for (let step = 0; step <= OUTLINE_ARC_STEPS; step++) {
        arc.push(contact(-this.trailingAngle + ((this.leadAngle + this.trailingAngle) * step) / OUTLINE_ARC_STEPS));
      }
      const first = arc[0];
      const last = arc[arc.length - 1];
      const trailingEnd = pt(first.z - edgeLength * Math.cos(trailing), first.r - edgeLength * Math.sin(trailing));
      const leadEnd = pt(last.z + edgeLength * Math.cos(lead), last.r + edgeLength * Math.sin(lead));
      return [trailingEnd, ...arc, leadEnd];
    }
  }

  // ---------------------------------------------------------------- Сегменты схемы

  const ARC_STEPS = 48;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  class Segment {
    /** Пройденная часть сегмента для рисования. */
    sampleUpTo(fraction) {
      const points = this.sample();
      const passed = Math.trunc(fraction * (points.length - 1)) + 1;
      return points.slice(0, passed).concat([this.pointAt(fraction)]);
    }
  }

  class Line extends Segment {
    constructor(start, end) {
      super();
      this.kind = 'line';
      this.start = start;
      this.end = end;
    }

    get length() {
      return Math.hypot(this.end.z - this.start.z, this.end.r - this.start.r);
    }

    sample() {
      return [this.start, this.end];
    }

    pointAt(fraction) {
      return pt(
        this.start.z + (this.end.z - this.start.z) * fraction,
        this.start.r + (this.end.r - this.start.r) * fraction,
      );
    }

    nearestFraction(point) {
      const dz = this.end.z - this.start.z;
      const dr = this.end.r - this.start.r;
      const projection = (point.z - this.start.z) * dz + (point.r - this.start.r) * dr;
      return clamp(projection / (dz * dz + dr * dr), 0, 1);
    }

    reversed() {
      return new Line(this.end, this.start);
    }
  }

  /** clockwise считается при Z вправо и X вверх. */
  class Arc extends Segment {
    constructor(start, end, center, radius, clockwise) {
      super();
      this.kind = 'arc';
      this.start = start;
      this.end = end;
      this.center = center;
      this.radius = radius;
      this.clockwise = clockwise;
    }

    get startAngle() {
      return Math.atan2(this.start.r - this.center.r, this.start.z - this.center.z);
    }

    get sweep() {
      const delta = Math.atan2(this.end.r - this.center.r, this.end.z - this.center.z) - this.startAngle;
      if (this.clockwise && delta > 0) return delta - 2 * Math.PI;
      if (!this.clockwise && delta < 0) return delta + 2 * Math.PI;
      return delta;
    }

    get length() {
      return this.radius * Math.abs(this.sweep);
    }

    sample() {
      const points = [];
      for (let step = 0; step <= ARC_STEPS; step++) points.push(this.pointAt(step / ARC_STEPS));
      return points;
    }

    pointAt(fraction) {
      const angle = this.startAngle + this.sweep * fraction;
      return pt(this.center.z + this.radius * Math.cos(angle), this.center.r + this.radius * Math.sin(angle));
    }

    nearestFraction(point) {
      const sweep = this.sweep;
      const middle = this.startAngle + sweep / 2;
      const angle = Math.atan2(point.r - this.center.r, point.z - this.center.z);
      const fromMiddle = Math.atan2(Math.sin(angle - middle), Math.cos(angle - middle));
      return clamp(0.5 + fromMiddle / sweep, 0, 1);
    }

    reversed() {
      return new Arc(this.end, this.start, this.center, this.radius, !this.clockwise);
    }
  }

  /** Ход вершины резца по нескольким кадрам. Доля считается по длине пути. */
  class ToolPath {
    constructor(segments) {
      this.segments = segments;
    }

    get start() {
      return this.segments[0].start;
    }

    get end() {
      return this.segments[this.segments.length - 1].end;
    }

    sample() {
      return this.segments.flatMap((segment) => segment.sample());
    }

    pointAt(fraction) {
      let remaining = fraction * this.segments.reduce((sum, segment) => sum + segment.length, 0);
      for (const segment of this.segments) {
        const length = segment.length;
        if (remaining <= length) return segment.pointAt(length > 0 ? remaining / length : 0);
        remaining -= length;
      }
      return this.end;
    }
  }

  const TURNING_TOOL = Object.freeze({ kind: 'turning' });
  const partingTool = (width) => ({ kind: 'parting', width });

  /**
   * Данные схемы. programmed получен разбором выведенных кадров, а не из расчёта,
   * поэтому схема показывает то, что выполнит станок.
   */
  class ToolpathPreview {
    constructor({ contour, programmed, toolRadius, materialBeforeStart, edges = null, tool = TURNING_TOOL }) {
      this.contour = contour;
      this.programmed = programmed;
      this.toolRadius = toolRadius;
      this.materialBeforeStart = materialBeforeStart;
      this.edges = edges;
      this.tool = tool;
    }

    /** Центр режущей вершины, когда программируемая точка в tip. */
    noseCenter(tip) {
      if (this.tool.kind === 'parting') {
        return pt(tip.z - this.tool.width + this.toolRadius, tip.r + this.toolRadius);
      }
      return pt(tip.z - this.toolRadius, tip.r + this.toolRadius);
    }

    withPath(contour, programmed) {
      return new ToolpathPreview({ ...this, contour, programmed });
    }
  }

  const CORNER_STEPS = 8;

  /** Контур отрезного резца, когда программируемый дальний угол в tip. */
  function partingBladeOutline(tip, width, radius, height) {
    const near = pt(tip.z - width + radius, tip.r + radius);
    const far = pt(tip.z - radius, tip.r + radius);
    const corner = (center, from, to) => {
      const points = [];
      for (let step = 0; step <= CORNER_STEPS; step++) {
        const angle = toRadians(from + ((to - from) * step) / CORNER_STEPS);
        points.push(pt(center.z + radius * Math.cos(angle), center.r + radius * Math.sin(angle)));
      }
      return points;
    };
    return [
      pt(tip.z - width, tip.r + height),
      ...corner(near, 180, 270),
      ...corner(far, 270, 360),
      pt(tip.z, tip.r + height),
    ];
  }

  // ---------------------------------------------------------------- Разбор кадров

  const WORD = /([GXZR])(-?\d+(?:\.\d+)?)/g;

  /**
   * Разбирает кадры так, как их выполнит стойка: X на диаметр, дуга через R не больше 180 градусов.
   * Первый кадр считается подводом и задаёт начальную точку.
   */
  function backplot(blocks) {
    let position = null;
    const segments = [];
    blocks.filter((block) => !block.startsWith('(')).forEach((block) => {
      const words = {};
      for (const match of block.matchAll(WORD)) words[match[1]] = match[2];
      const target = pt(Number(words.Z), Number(words.X) / 2);
      if (position) {
        const code = parseInt(words.G, 10);
        if (code === 1) segments.push(new Line(position, target));
        else if (code === 2 || code === 3) segments.push(arcThrough(position, target, Number(words.R), code === 2));
        else throw new Error('Unsupported G code: ' + code);
      }
      position = target;
    });
    return segments;
  }

  function arcThrough(from, to, radius, clockwise) {
    const dz = to.z - from.z;
    const dr = to.r - from.r;
    const chord = Math.hypot(dz, dr);
    const height = Math.sqrt(Math.max(0, radius * radius - (chord * chord) / 4));
    const side = clockwise ? -height : height;
    const center = pt((from.z + to.z) / 2 - (dr / chord) * side, (from.r + to.r) / 2 + (dz / chord) * side);
    return new Arc(from, to, center, radius, clockwise);
  }

  // ---------------------------------------------------------------- Результат

  const success = (blocks, contour, warnings, preview) => ({ ok: true, blocks, contour, warnings, preview });
  const failure = (problem) => ({ ok: false, problem });
  const contourPoints = (startX, startZ, endX, endZ) => ({ startX, startZ, endX, endZ });

  const position = (point) => `X${format(point.r * 2)} Z${format(point.z)}`;

  /** Нормаль наружу от детали для движения по direction: материал остаётся со стороны оси. */
  function outwardNormal(direction) {
    const length = len(direction);
    return pt(-direction.r / length, direction.z / length);
  }

  /** Точка на той же прямой при заданном Z. */
  const moveAlongLineToZ = (tip, tangent, z) => pt(z, tip.r + (tangent.r * (z - tip.z)) / tangent.z);

  /** Точка на той же прямой на заданном радиусе. */
  function moveAlongLineToRadius(tip, tangent, radius) {
    const distance = radius - tip.r;
    if (distance <= EPSILON) return tip;
    return pt(tip.z + (tangent.z * distance) / tangent.r, radius);
  }

  // ---------------------------------------------------------------- Обратный ход

  const MOVE = /^(G0[123]) (X\S+ Z\S+)(?: (R\S+))?$/;

  function reverseBlocks(blocks) {
    const comment = blocks.find((block) => block.startsWith('('));
    const moves = blocks.filter((block) => !block.startsWith('(')).map((block) => {
      const match = MOVE.exec(block);
      if (!match) throw new Error('Unsupported block: ' + block);
      return { code: match[1], target: match[2], radius: match[3] || '' };
    });
    const result = ['(BACK ' + comment.slice(1), 'G01 ' + moves[moves.length - 1].target];
    // Кадр ведёт в свою точку, поэтому при развороте он ведёт в точку предыдущего кадра.
    for (let index = moves.length - 1; index >= 1; index--) {
      const { code, radius } = moves[index];
      const target = moves[index - 1].target;
      result.push([oppositeDirection(code), target, radius].filter((part) => part !== '').join(' '));
    }
    return result;
  }

  const oppositeDirection = (code) => (code === 'G02' ? 'G03' : code === 'G03' ? 'G02' : code);

  /** Обратный ход это тот же контур задом наперёд, строится из готовых кадров прямого хода. */
  function reversedIf(result, isBackCut) {
    if (!isBackCut || !result.ok) return result;
    const blocks = reverseBlocks(result.blocks);
    return {
      ...result,
      blocks,
      preview: result.preview.withPath(result.preview.contour.reversed(), new ToolPath(backplot(blocks))),
    };
  }

  // ---------------------------------------------------------------- Фаска проходным

  /** Угол от оси Z, длина это катет вдоль Z: фаска 0.5x45 даёт разницу диаметров 1.0. */
  function generateChamfer(input) {
    return reversedIf(generateForwardChamfer(input), !!input.isBackCut);
  }

  function generateForwardChamfer(input) {
    if (input.toolRadius < 0) return failure('NEGATIVE_TOOL_RADIUS');
    const resolved = resolveChamfer(input);
    if (resolved.problem) return failure(resolved.problem);
    const contour = resolved.contour;
    const edges = input.edges || null;

    const start = pt(contour.startZ, contour.startX / 2);
    const end = pt(contour.endZ, contour.endX / 2);
    const direction = sub(end, start);
    const normal = outwardNormal(direction);
    const shift = add(mul(normal, input.toolRadius), tipOffset(input.toolRadius));
    const tangent = pt(normal.r, -normal.z);
    const programStart = moveAlongLineToZ(add(start, shift), tangent, start.z);
    // Формула одна: при падающем X касательная ведёт назад по той же прямой, то есть ход обрезается.
    const programEnd = moveAlongLineToRadius(add(end, shift), tangent, end.r);

    const warnings = [];
    if (Math.min(programStart.r, programEnd.r) < -EPSILON) warnings.push('X_BELOW_ZERO');
    if (!edges) {
      if (normal.z > EPSILON) warnings.push('TRAILING_EDGE_CONTACT');
    } else {
      const contourAngle = toDegrees(Math.atan2(direction.r, direction.z));
      if (edges.cutsWithTrailingEdge(contourAngle)) warnings.push('INSERT_TRAILING_EDGE');
      if (edges.cutsWithLeadEdge(contourAngle)) warnings.push('INSERT_LEAD_EDGE');
    }
    const degrees = toDegrees(Math.atan(Math.abs(direction.r) / direction.z));
    const blocks = [
      `(CHAMFER Z${format(direction.z)} A${format(degrees)} TOOL R${format(input.toolRadius)})`,
      `G01 ${position(programStart)}`,
      `G01 ${position(programEnd)}`,
    ];
    return success(blocks, contour, warnings, new ToolpathPreview({
      contour: new Line(start, end),
      programmed: new ToolPath(backplot(blocks)),
      toolRadius: input.toolRadius,
      materialBeforeStart: direction.r < 0,
      edges,
    }));
  }

  function resolveChamfer(input) {
    const rejected = (problem) => ({ problem });
    const { angleDegrees: angle, length } = input;
    const startX = input.startX ?? null;
    const startZ = input.startZ ?? null;
    const endX = input.endX ?? null;
    const endZ = input.endZ ?? null;

    if (angle != null && (angle <= 0 || angle >= 90)) return rejected('ANGLE_OUT_OF_RANGE');
    if (length != null && length <= 0) return rejected('NON_POSITIVE_LENGTH');
    if ([startX, endX].some((x) => x != null && x < 0)) return rejected('NEGATIVE_X');
    if (startX == null && endX == null) return rejected('NOT_ENOUGH_DATA');
    if (startZ == null && endZ == null) return rejected('NOT_ENOUGH_DATA');

    const zFromPoints = startZ != null && endZ != null ? endZ - startZ : null;
    const radialFromPoints = startX != null && endX != null ? (endX - startX) / 2 : null;

    if (zFromPoints != null && zFromPoints <= 0) return rejected('Z_NOT_INCREASING');
    if (radialFromPoints != null && Math.abs(radialFromPoints) < EPSILON) return rejected('X_NOT_CHANGING');
    if (zFromPoints != null && length != null && Math.abs(zFromPoints - length) > TOLERANCE) {
      return rejected('LENGTH_CONFLICT');
    }

    const tangent = angle != null ? Math.tan(toRadians(angle)) : null;
    let dz = zFromPoints ?? length ?? null;
    if (dz == null) {
      if (radialFromPoints != null && tangent != null) dz = Math.abs(radialFromPoints) / tangent;
      else return rejected('NOT_ENOUGH_DATA');
    }
    // Рассчитанный X всегда растёт по ходу резания. Фаску с убывающим X задают всеми координатами.
    const radial = radialFromPoints ?? (tangent != null ? dz * tangent : null);
    if (radial == null) return rejected('NOT_ENOUGH_DATA');
    if (tangent != null && Math.abs(Math.abs(radial) - dz * tangent) > TOLERANCE) {
      return rejected('ANGLE_CONFLICT');
    }

    const resolvedStartZ = startZ ?? endZ - dz;
    const resolvedEndZ = endZ ?? resolvedStartZ + dz;
    const resolvedStartX = startX ?? endX - 2 * radial;
    const resolvedEndX = endX ?? resolvedStartX + 2 * radial;
    if (resolvedStartX < 0 || resolvedEndX < 0) return rejected('NEGATIVE_X');
    return { contour: contourPoints(resolvedStartX, resolvedStartZ, resolvedEndX, resolvedEndZ) };
  }

  // ---------------------------------------------------------------- Скругление проходным

  /**
   * Скругление симметрично: катеты по Z и по радиусу равны R. Начальный Z и конечный X задают его положение.
   */
  function generateFillet(input) {
    return reversedIf(generateForwardFillet(input), !!input.isBackCut);
  }

  function generateForwardFillet(input) {
    const { toolRadius, radius, isConvex } = input;
    const edges = input.edges || null;
    if (toolRadius < 0) return failure('NEGATIVE_TOOL_RADIUS');
    if (radius <= 0) return failure('NON_POSITIVE_RADIUS');
    if (input.endX < 0) return failure('NEGATIVE_X');

    const endR = input.endX / 2;
    if (endR - radius < -EPSILON) return failure('RADIUS_TOO_LARGE_FOR_DIAMETER');

    const programRadius = isConvex ? radius + toolRadius : radius - toolRadius;
    if (programRadius <= EPSILON) return failure('TOOL_RADIUS_TOO_LARGE');

    const start = pt(input.startZ, endR - radius);
    const end = pt(input.startZ + radius, endR);
    // Выпуклое идёт от торца к диаметру, вогнутое от диаметра к уступу.
    const center = isConvex ? pt(end.z, start.r) : pt(start.z, end.r);
    const startNormal = isConvex ? pt(-1, 0) : pt(0, 1);
    const endNormal = isConvex ? pt(0, 1) : pt(-1, 0);

    const offset = tipOffset(toolRadius);
    const programStart = add(add(start, mul(startNormal, toolRadius)), offset);
    const programEnd = add(add(end, mul(endNormal, toolRadius)), offset);

    // Вогнутая дуга начинается позже начального Z и заканчивается ниже конечного X:
    // до неё и после неё вершина идёт по прямой, по диаметру и по уступу.
    const leadStart = isConvex ? programStart : start;
    const finish = isConvex ? programEnd : end;

    const warnings = [];
    if (Math.min(leadStart.r, programStart.r) < -EPSILON) warnings.push('X_BELOW_ZERO');
    // Дуга проходит все углы от диаметра до торца: вершина должна доставать и туда, и туда.
    if (edges) {
      if (edges.cutsWithTrailingEdge(0)) warnings.push('INSERT_TRAILING_EDGE');
      if (edges.cutsWithLeadEdge(FACE_ANGLE)) warnings.push('INSERT_LEAD_EDGE');
    }
    // При Z+ в сторону детали выпуклая дуга идёт по часовой стрелке: так задано на станке.
    const code = isConvex ? 'G02' : 'G03';
    const shape = isConvex ? 'CONVEX' : 'CONCAVE';
    const blocks = [`(${shape} R${format(radius)} TOOL R${format(toolRadius)})`, `G01 ${position(leadStart)}`];
    if (position(leadStart) !== position(programStart)) blocks.push(`G01 ${position(programStart)}`);
    blocks.push(`${code} ${position(programEnd)} R${format(programRadius)}`);
    if (position(finish) !== position(programEnd)) blocks.push(`G01 ${position(finish)}`);

    return success(blocks, contourPoints(start.r * 2, start.z, input.endX, end.z), warnings, new ToolpathPreview({
      contour: new Arc(start, end, center, radius, isConvex),
      programmed: new ToolPath(backplot(blocks)),
      toolRadius,
      materialBeforeStart: !isConvex,
      edges,
    }));
  }

  // ---------------------------------------------------------------- Отрезка

  /** Отвод над диаметром, на диаметр: 0.5 мм на сторону. */
  const PARTING_CLEARANCE_X = 1.0;
  /** Насколько канавка глубже притупления, на диаметр. */
  const GROOVE_MARGIN_X = 0.4;
  /** Ниже канавки резец под сферой может сместиться к прутку не больше чем на это. */
  const SPHERE_SIDE_TRAVEL = 0.1;

  /** Переход от центра ближнего угла к его условной вершине. */
  const nearTipOffset = (r) => pt(-r, -r);

  /**
   * edge: { type: 'chamfer', length, angleDegrees } | { type: 'fillet', radius } | { type: 'sphere', radius }.
   * grooveX: диаметр предварительной канавки, null — рассчитать.
   */
  function generateParting(input) {
    const width = input.toolWidth;
    const r = input.toolRadius;
    const grooveInput = input.grooveX ?? null;
    if (input.diameter <= 0) return failure('NON_POSITIVE_DIAMETER');
    if (width <= 0) return failure('NON_POSITIVE_WIDTH');
    if (r < 0) return failure('NEGATIVE_TOOL_RADIUS');
    if (2 * r > width + EPSILON) return failure('TOOL_RADIUS_TOO_LARGE_FOR_WIDTH');
    if (grooveInput != null && (grooveInput <= 0 || grooveInput >= input.diameter)) {
      return failure('GROOVE_DEPTH_INVALID');
    }

    let profile;
    if (input.edge.type === 'chamfer') profile = chamferProfile(input, input.edge);
    else if (input.edge.type === 'fillet') profile = filletProfile(input, input.edge);
    else profile = sphereProfile(input, input.edge);
    if (profile.problem) return failure(profile.problem);

    const faceZ = input.partEndZ;
    const nearToFar = pt(width, 0);
    const approachX = input.diameter + PARTING_CLEARANCE_X;
    const grooveX = grooveInput ?? profile.autoGrooveX;
    const warnings = [];
    if (grooveInput != null && profile.deepestX != null && grooveInput > profile.deepestX - EPSILON) {
      warnings.push('GROOVE_SHALLOW');
    }

    const at = (x, z) => `X${format(x)} Z${format(z)}`;
    const program = (tip) => position(add(tip, nearToFar));
    const farFaceZ = faceZ + width;
    const blocks = [`(PART-OFF ${profile.description} W${format(width)} TOOL R${format(r)})`];
    blocks.push(`G01 ${at(approachX, farFaceZ)}`);
    if (grooveX != null && grooveX > EPSILON) {
      blocks.push(`G01 ${at(grooveX, farFaceZ)}`);
      blocks.push(`G01 ${at(approachX, farFaceZ)}`);
    }
    const lead = profile.moves[0].target;
    blocks.push(`G01 ${at(approachX, lead.z + width)}`);
    profile.moves.forEach((move) => {
      const parts = [move.code, program(move.target)];
      if (move.radius != null) parts.push(`R${format(move.radius)}`);
      blocks.push(parts.join(' '));
    });
    // Отрезка по торцу. После сферы резец уже за осью.
    const last = profile.moves[profile.moves.length - 1].target;
    const cutOff = pt(faceZ, -r);
    if (program(last) !== program(cutOff)) blocks.push(`G01 ${program(cutOff)}`);

    return success(blocks, profile.contour, warnings, new ToolpathPreview({
      contour: profile.segment,
      programmed: new ToolPath(backplot(blocks)),
      toolRadius: r,
      materialBeforeStart: true,
      tool: partingTool(width),
    }));
  }

  function chamferProfile(input, edge) {
    if (edge.angleDegrees <= 0 || edge.angleDegrees >= 90) return { problem: 'ANGLE_OUT_OF_RANGE' };
    if (edge.length <= 0) return { problem: 'NON_POSITIVE_LENGTH' };
    const r = input.toolRadius;
    const outer = input.diameter / 2;
    const radial = edge.length * Math.tan(toRadians(edge.angleDegrees));
    if (radial >= outer - EPSILON) return { problem: 'PARTING_EDGE_TOO_DEEP' };

    const start = pt(input.partEndZ - edge.length, outer);
    const end = pt(input.partEndZ, outer - radial);
    const direction = sub(end, start);
    const length = len(direction);
    // Наружу от детали: материал ниже и ближе к переднему торцу.
    const normal = pt(radial / length, edge.length / length);
    const tangent = pt(direction.z / length, direction.r / length);
    const shift = add(mul(normal, r), nearTipOffset(r));
    const rawStart = add(start, shift);
    const rawEnd = add(end, shift);
    // Продление по касательной: начало на диаметре детали, конец на торце отрезки.
    const tipStart = add(rawStart, mul(tangent, (outer - rawStart.r) / tangent.r));
    const tipEnd = add(rawEnd, mul(tangent, (input.partEndZ - rawEnd.z) / tangent.z));
    const deepestX = tipEnd.r * 2;
    const groove = deepestX - GROOVE_MARGIN_X;
    if (groove <= EPSILON) return { problem: 'PARTING_EDGE_TOO_DEEP' };
    return {
      description: `CHAMFER Z${format(edge.length)} A${format(edge.angleDegrees)}`,
      moves: [{ code: 'G01', target: tipStart }, { code: 'G01', target: tipEnd }],
      contour: contourPoints(input.diameter, start.z, end.r * 2, end.z),
      segment: new Line(start, end),
      deepestX,
      autoGrooveX: groove,
    };
  }

  function filletProfile(input, edge) {
    const radius = edge.radius;
    if (radius <= 0) return { problem: 'NON_POSITIVE_RADIUS' };
    const r = input.toolRadius;
    const outer = input.diameter / 2;
    if (radius >= outer - EPSILON) return { problem: 'PARTING_EDGE_TOO_DEEP' };

    const start = pt(input.partEndZ - radius, outer);
    const end = pt(input.partEndZ, outer - radius);
    const center = pt(start.z, end.r);
    // Центр ближнего угла идёт по дуге R+r: сверху над началом и справа от конца.
    const tipStart = add(add(start, pt(0, r)), nearTipOffset(r));
    const tipEnd = add(add(end, pt(r, 0)), nearTipOffset(r));
    const deepestX = tipEnd.r * 2;
    const groove = deepestX - GROOVE_MARGIN_X;
    if (groove <= EPSILON) return { problem: 'PARTING_EDGE_TOO_DEEP' };
    return {
      description: `CONVEX R${format(radius)}`,
      // Выпуклая дуга от диаметра к торцу идёт по часовой стрелке, как и у проходного: G02.
      moves: [{ code: 'G01', target: tipStart }, { code: 'G02', target: tipEnd, radius: radius + r }],
      contour: contourPoints(input.diameter, start.z, end.r * 2, end.z),
      segment: new Arc(start, end, center, radius, true),
      deepestX,
      autoGrooveX: groove,
    };
  }

  function sphereProfile(input, edge) {
    const sphere = edge.radius;
    if (sphere <= 0) return { problem: 'NON_POSITIVE_RADIUS' };
    const r = input.toolRadius;
    const outer = input.diameter / 2;
    if (sphere < outer - EPSILON) return { problem: 'SPHERE_RADIUS_TOO_SMALL' };

    const pole = pt(input.partEndZ, 0);
    const center = pt(input.partEndZ - sphere, 0);
    // Угол от оси до кромки сферы на диаметре, из центра сферы.
    const edgeAngle = Math.asin(Math.min(outer / sphere, 1));
    const toRim = pt(Math.cos(edgeAngle), Math.sin(edgeAngle));
    const rim = add(center, mul(toRim, sphere));
    const programRadius = sphere + r;
    const arcStart = add(add(center, mul(toRim, programRadius)), nearTipOffset(r));
    const arcEnd = add(add(pole, pt(r, 0)), nearTipOffset(r));
    // До дуги вершина идёт по касательной к ней от диаметра детали: кромка сферы остаётся острой.
    const tangent = pt(Math.sin(edgeAngle), -Math.cos(edgeAngle));
    const lead = tangent.r < -EPSILON ? add(arcStart, mul(tangent, (outer - arcStart.r) / tangent.r)) : arcStart;
    const moves = [{ code: 'G01', target: lead }];
    if (position(lead) !== position(arcStart)) moves.push({ code: 'G01', target: arcStart });
    moves.push({ code: 'G02', target: arcEnd, radius: programRadius });
    // Канавка до радиуса, ниже которого резец сместится к прутку не больше чем на SPHERE_SIDE_TRAVEL.
    const cosLimit = 1 - SPHERE_SIDE_TRAVEL / programRadius;
    const grooveTip = programRadius * Math.sqrt(1 - cosLimit * cosLimit) - r;
    const groove = Math.min(grooveTip * 2, arcStart.r * 2 - GROOVE_MARGIN_X);
    return {
      description: `SPHERE SR${format(sphere)}`,
      moves,
      contour: contourPoints(input.diameter, rim.z, 0, pole.z),
      segment: new Arc(rim, pole, center, sphere, true),
      deepestX: null,
      autoGrooveX: groove > EPSILON ? groove : null,
    };
  }

  // ---------------------------------------------------------------- Сфера проходным

  /**
   * Сфера на переднем торце: от оси при начальном Z к диаметру детали, G02.
   * Вершина начинает за осью, на X = -2r, иначе в центре остался бы бугорок.
   */
  function generateSphere(input) {
    return reversedIf(generateForwardSphere(input), !!input.isBackCut);
  }

  function generateForwardSphere(input) {
    const r = input.toolRadius;
    const sphere = input.sphereRadius;
    const outer = input.diameter / 2;
    const edges = input.edges || null;
    if (r < 0) return failure('NEGATIVE_TOOL_RADIUS');
    if (input.diameter <= 0) return failure('NON_POSITIVE_DIAMETER');
    if (sphere <= 0) return failure('NON_POSITIVE_RADIUS');
    if (sphere < outer - EPSILON) return failure('SPHERE_RADIUS_TOO_SMALL');

    const apex = pt(input.startZ, 0);
    const center = pt(input.startZ + sphere, 0);
    const edgeAngle = Math.asin(Math.min(outer / sphere, 1));
    // Направление из центра на кромку: назад к торцу и вверх.
    const toRim = pt(-Math.cos(edgeAngle), Math.sin(edgeAngle));
    const rim = add(center, mul(toRim, sphere));
    const programRadius = sphere + r;
    const offset = tipOffset(r);
    const programStart = add(add(apex, pt(-r, 0)), offset);
    const arcEnd = add(add(center, mul(toRim, programRadius)), offset);
    const tangent = pt(Math.sin(edgeAngle), Math.cos(edgeAngle));
    const finish = tangent.r > EPSILON ? add(arcEnd, mul(tangent, (outer - arcEnd.r) / tangent.r)) : arcEnd;

    const warnings = [];
    if (programStart.r < -EPSILON) warnings.push('X_BELOW_ZERO');
    // У оси сфера идёт поперёк детали, как торец: туда должна доставать вершина.
    if (edges && edges.cutsWithLeadEdge(FACE_ANGLE)) warnings.push('INSERT_LEAD_EDGE');
    const blocks = [
      `(SPHERE SR${format(sphere)} TOOL R${format(r)})`,
      `G01 ${position(programStart)}`,
      `G02 ${position(arcEnd)} R${format(programRadius)}`,
    ];
    if (position(finish) !== position(arcEnd)) blocks.push(`G01 ${position(finish)}`);
    return success(blocks, contourPoints(0, apex.z, input.diameter, rim.z), warnings, new ToolpathPreview({
      contour: new Arc(apex, rim, center, sphere, true),
      programmed: new ToolPath(backplot(blocks)),
      toolRadius: r,
      materialBeforeStart: false,
      edges,
    }));
  }

  // ---------------------------------------------------------------- Отвод фрезы по Y

  /*
   * Поперечная приводная фреза на гребёнке: её ось идёт по X, к детали она подходит опусканием по X.
   * В сечении поперёк детали фреза занимает полосу шириной в свой диаметр вокруг своего Y.
   * Пока торец фрезы опускается до радиуса h, на её пути весь материал выше h,
   * а это хорда заготовки полушириной √(R² − h²). Центр фрезы должен быть дальше от оси на радиус фрезы и зазор.
   * Фреза, которая доходит до оси или проходит её, встречает всю ширину заготовки: полуширина равна R.
   */
  function generateMillingRetract(input) {
    const { stockDiameter, cutterDiameter, clearance } = input;
    const depthX = input.depthX ?? null;
    if (stockDiameter <= 0) return failure('NON_POSITIVE_DIAMETER');
    if (cutterDiameter <= 0) return failure('NON_POSITIVE_CUTTER');
    if (clearance < 0) return failure('NEGATIVE_CLEARANCE');

    const stockR = stockDiameter / 2;
    const cutterR = cutterDiameter / 2;
    // Торец фрезы ниже оси: самое широкое место заготовки он уже прошёл.
    const depthR = depthX == null ? 0 : Math.max(0, depthX / 2);
    const aboveStock = depthR >= stockR - EPSILON;
    const halfWidth = aboveStock ? 0 : Math.sqrt(stockR * stockR - depthR * depthR);
    const centerY = halfWidth + cutterR + clearance;
    // Y на диаметр, как X: в программе вдвое больше, чем фактический сдвиг.
    const programY = input.yOnDiameter ? centerY * 2 : centerY;
    return {
      ok: true,
      kind: 'retract',
      stockR,
      cutterR,
      depthR,
      depthX,
      clearance,
      halfWidth,
      centerY,
      programY,
      aboveStock,
      yOnDiameter: !!input.yOnDiameter,
    };
  }

  const api = {
    format,
    generateMillingRetract,
    parseNumber,
    isInvalidNumber,
    parseInsert,
    typicalLeadAngle,
    parsePartingWidth,
    ToolEdges,
    Line,
    Arc,
    ToolPath,
    backplot,
    partingBladeOutline,
    generateChamfer,
    generateFillet,
    generateSphere,
    generateParting,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
