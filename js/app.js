/* Экран расчёта: перенос GcodeScreen.kt. */
(function () {
  'use strict';

  const { format, parseNumber, isInvalidNumber, parseInsert, typicalLeadAngle, parsePartingWidth, ToolEdges } = GCode;

  const STORAGE_KEY = 'steeltouch-gcode-v1';

  const DEFAULTS = {
    tool: 'turning',
    shape: 'chamfer',
    direction: 'forward',
    convexity: 'convex',
    startX: '', startZ: '', endX: '', endZ: '', angle: '', length: '', radius: '', toolRadius: '',
    insertCode: '', leadAngle: '',
    // Отрезной резец и деталь при отрезке хранятся отдельно: радиус проходного сюда переноситься не должен.
    partDiameter: '', partEndZ: '', partingAngle: '45', partingLength: '', partingSize: '',
    partingCode: '', partingWidth: '', partingRadius: '', grooveX: '',
    millStockDiameter: '', millCutterDiameter: '', millClearance: '1', millDepthX: '', millYMode: 'diameter',
  };

  const MESSAGES = {
    FIELD_INVALID: 'Проверьте поля, выделенные красным: там не число.',
    FIELD_REQUIRED: 'Заполните все поля.',
    INSERT_INVALID: 'Не удалось разобрать обозначение пластины. Пример: DCMT 11T304 или CCGT 09T302.',
    INSERT_LEAD_INVALID: 'Такой угол в плане невозможен для этой формы пластины. Проверьте державку.',
    NEGATIVE_TOOL_RADIUS: 'Радиус резца не может быть отрицательным.',
    NEGATIVE_X: 'Диаметр не может быть отрицательным.',
    NOT_ENOUGH_DATA: 'Данных не хватает: нужны хотя бы один X, один Z и столько угла и длины, чтобы рассчитать остальное.',
    ANGLE_OUT_OF_RANGE: 'Угол должен быть больше 0° и меньше 90°.',
    NON_POSITIVE_LENGTH: 'Длина должна быть больше нуля.',
    LENGTH_CONFLICT: 'Длина не совпадает с разницей Z между точками.',
    ANGLE_CONFLICT: 'Угол не совпадает с координатами. Проверьте точки: X задан на диаметр.',
    Z_NOT_INCREASING: 'Конечный Z должен быть больше начального: поддерживается только резание в сторону Z+.',
    X_NOT_CHANGING: 'Начальный и конечный X равны: это не фаска.',
    NON_POSITIVE_RADIUS: 'Радиус детали должен быть больше нуля.',
    RADIUS_TOO_LARGE_FOR_DIAMETER: 'Радиус слишком большой: конечный X должен быть не меньше двух радиусов.',
    TOOL_RADIUS_TOO_LARGE: 'Радиус резца должен быть меньше радиуса вогнутого скругления.',
    NON_POSITIVE_DIAMETER: 'Диаметр детали должен быть больше нуля.',
    NON_POSITIVE_WIDTH: 'Ширина резца должна быть больше нуля.',
    TOOL_RADIUS_TOO_LARGE_FOR_WIDTH: 'Два радиуса резца больше его ширины. Проверьте ширину и радиус.',
    PARTING_EDGE_TOO_DEEP: 'Притупление слишком большое для этого диаметра: оно доходит почти до оси. Для такого торца выберите сферу.',
    SPHERE_RADIUS_TOO_SMALL: 'Радиус сферы меньше радиуса детали: такая сфера не выйдет на диаметр.',
    GROOVE_DEPTH_INVALID: 'Канавка должна быть больше X0 и меньше диаметра детали.',
    NON_POSITIVE_CUTTER: 'Диаметр фрезы должен быть больше нуля.',
    NEGATIVE_CLEARANCE: 'Зазор не может быть отрицательным.',
  };

  function warningText(warning, result) {
    const edges = result.preview.edges;
    switch (warning) {
      case 'X_BELOW_ZERO':
        return 'X меньше нуля: вершина резца заходит за ось. Проверьте, допустимо ли это.';
      case 'TRAILING_EDGE_CONTACT':
        return 'Контур уходит вниз по ходу резания. Проверьте, что форма пластины и державка это позволяют.';
      case 'INSERT_TRAILING_EDGE':
        return `Задняя кромка зарежет деталь: с этой пластиной и державкой контур с задней стороны может быть наклонён к оси Z не круче ${format(edges ? edges.maxFallingAngle : 0)}°. Нужна пластина с меньшим углом при вершине или другая державка.`;
      case 'INSERT_LEAD_EDGE':
        return `Контур круче угла в плане ${format(edges ? edges.leadAngle : 0)}°: в него упрётся главная кромка, а не вершина. Нужна державка с большим углом в плане.`;
      case 'GROOVE_SHALLOW':
        return 'Канавка мельче притупления: задняя сторона резца будет тереть пруток. Сделайте её глубже или оставьте поле пустым.';
      default:
        return warning;
    }
  }

  const isInsertWarning = (warning) => warning === 'INSERT_TRAILING_EDGE' || warning === 'INSERT_LEAD_EDGE';

  // ---------------------------------------------------------------- Состояние

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const state = { ...DEFAULTS };
      Object.keys(DEFAULTS).forEach((key) => {
        if (typeof saved[key] === 'string') state[key] = saved[key];
      });
      return state;
    } catch (error) {
      return { ...DEFAULTS };
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      // Без хранилища расчёт работает, значения просто не переживут перезагрузку.
    }
  }

  const state = loadState();
  let plot = null;

  const screen = document.getElementById('screen');
  const resultBox = document.getElementById('result');
  const fields = Array.from(document.querySelectorAll('.field'));
  const inputsByKey = {};

  // ---------------------------------------------------------------- Поля

  fields.forEach((field, index) => {
    const key = field.dataset.key;
    const input = field.querySelector('input');
    const label = field.querySelector('label');
    const id = `field-${key}-${index}`;
    input.id = id;
    label.htmlFor = id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');
    if ('text' in field.dataset) {
      input.type = 'text';
      input.autocapitalize = 'characters';
      input.enterKeyHint = 'next';
    } else {
      input.type = 'text';
      input.inputMode = 'decimal';
      input.enterKeyHint = 'next';
    }
    input.value = state[key];
    (inputsByKey[key] = inputsByKey[key] || []).push(input);

    field.addEventListener('click', (event) => {
      if (event.target === field) input.focus();
    });

    input.addEventListener('input', () => setField(key, input.value, input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        focusNext(input);
      }
    });

    if ('signed' in field.dataset) {
      const sign = document.createElement('button');
      sign.type = 'button';
      sign.className = 'sign';
      sign.textContent = '±';
      sign.tabIndex = -1;
      sign.setAttribute('aria-label', 'Сменить знак');
      // Фокус остаётся в поле: клавиатура не прячется и не открывается заново.
      sign.addEventListener('pointerdown', (event) => event.preventDefault());
      sign.addEventListener('click', () => {
        const value = input.value.trim();
        const next = value.startsWith('-') ? value.slice(1) : '-' + value;
        input.value = next;
        setField(key, next, input);
      });
      field.appendChild(sign);
    }
  });

  function focusNext(current) {
    const visible = Array.from(screen.querySelectorAll('.field input')).filter((input) => input.offsetParent !== null);
    const next = visible[visible.indexOf(current) + 1];
    if (next) next.focus();
    else current.blur();
  }

  /** Любая правка сразу убирает результат: код от прежних значений нельзя скопировать по ошибке. */
  function changed() {
    clearOutcome();
    saveState();
    render();
  }

  function setField(key, value, source) {
    state[key] = value;
    if (key === 'insertCode') {
      // Радиус и державка следуют из обозначения, но остаются редактируемыми.
      const spec = parseInsert(value);
      if (spec) {
        if (spec.noseRadius != null) setValue('toolRadius', format(spec.noseRadius));
        const lead = typicalLeadAngle(spec.shape);
        setValue('leadAngle', lead != null ? format(lead) : '');
      }
    }
    if (key === 'partingCode') {
      const width = parsePartingWidth(value);
      if (width != null) setValue('partingWidth', format(width));
    }
    (inputsByKey[key] || []).forEach((input) => {
      if (input !== source) input.value = value;
    });
    changed();
  }

  function setValue(key, value) {
    state[key] = value;
    (inputsByKey[key] || []).forEach((input) => {
      input.value = value;
    });
  }

  // ---------------------------------------------------------------- Выбор вариантов

  document.querySelectorAll('[data-choice]').forEach((row) => {
    const key = row.dataset.choice;
    row.querySelectorAll('.choice').forEach((button) => {
      button.addEventListener('click', () => {
        if (state[key] === button.dataset.value) return;
        state[key] = button.dataset.value;
        changed();
      });
    });
  });

  // ---------------------------------------------------------------- Отрисовка формы

  function render() {
    const isTurning = state.tool === 'turning';
    const shown = new Set([state.tool, `${state.tool}-${state.shape}`]);
    if (state.direction === 'back') shown.add('back');
    if (state.shape !== 'chamfer') shown.add('turning-radius');
    if (state.tool !== 'milling') shown.add('shapes');

    screen.querySelectorAll('[data-show]').forEach((element) => {
      element.hidden = !shown.has(element.dataset.show);
    });
    document.querySelectorAll('[data-choice]').forEach((row) => {
      row.querySelectorAll('.choice').forEach((button) => {
        button.setAttribute('aria-pressed', String(state[row.dataset.choice] === button.dataset.value));
      });
    });

    const isSphere = state.shape === 'sphere';
    fields.forEach((field) => {
      const label = field.querySelector('[data-label-for-shape]');
      if (label && field.dataset.key === 'radius') label.textContent = isSphere ? 'Радиус сферы SR' : 'Радиус детали';
      if (label && field.dataset.key === 'partEndZ') label.textContent = isSphere ? 'Z вершины сферы' : 'Z торца отрезки';
    });

    // Пластина: описание и угол в плане только когда обозначение разобрано.
    const spec = parseInsert(state.insertCode);
    const description = document.getElementById('insert-description');
    description.hidden = !spec || !isTurning;
    if (spec) description.textContent = describeInsert(spec);
    // У круглой пластины нет вершины и кромок: проверять нечего.
    document.getElementById('lead-group').hidden = !spec || spec.noseAngle == null;

    fields.forEach((field) => {
      const key = field.dataset.key;
      const value = state[key];
      let invalid;
      if (key === 'insertCode') invalid = value.trim() !== '' && !spec;
      else if (key === 'partingCode') invalid = value.trim() !== '' && parsePartingWidth(value) == null;
      else invalid = isInvalidNumber(value);
      field.classList.toggle('invalid', invalid);
      field.querySelector('input').setAttribute('aria-invalid', String(invalid));
    });
  }

  function describeInsert(spec) {
    const parts = [spec.noseAngle != null ? `вершина ${format(spec.noseAngle)}°` : 'круглая'];
    if (spec.clearanceAngle != null) parts.push(`задний угол ${spec.clearanceAngle}°`);
    if (spec.noseRadius != null) parts.push(`радиус ${format(spec.noseRadius)} мм`);
    return parts.join(', ');
  }

  // ---------------------------------------------------------------- Расчёт

  const formError = (code) => ({ formError: code });
  const done = (result) => ({ result });

  /** null: пластина не указана, или её вершину проверить не по чему. */
  function resolveEdges() {
    if (state.insertCode.trim() === '') return { edges: null };
    const spec = parseInsert(state.insertCode);
    if (!spec) return { error: 'INSERT_INVALID' };
    if (spec.noseAngle == null) return { edges: null };
    if (isInvalidNumber(state.leadAngle)) return { error: 'FIELD_INVALID' };
    const lead = parseNumber(state.leadAngle);
    if (lead == null) return { edges: null };
    const edges = new ToolEdges(lead, spec.noseAngle);
    return edges.isPossible ? { edges } : { error: 'INSERT_LEAD_INVALID' };
  }

  function requireNumbers(values) {
    const numbers = values.map(parseNumber);
    return numbers.includes(null) ? null : numbers;
  }

  function calculate() {
    const isBackCut = state.direction === 'back';
    if (state.tool === 'parting') return calculateParting();
    if (state.tool === 'milling') return calculateMilling();

    const check = resolveEdges();
    if (state.shape === 'chamfer') {
      const values = [state.startX, state.startZ, state.endX, state.endZ, state.angle, state.length, state.toolRadius];
      if (check.error) return formError(check.error);
      if (values.some(isInvalidNumber)) return formError('FIELD_INVALID');
      const tool = parseNumber(state.toolRadius);
      if (tool == null) return formError('FIELD_REQUIRED');
      return done(GCode.generateChamfer({
        startX: parseNumber(state.startX),
        startZ: parseNumber(state.startZ),
        endX: parseNumber(state.endX),
        endZ: parseNumber(state.endZ),
        angleDegrees: parseNumber(state.angle),
        length: parseNumber(state.length),
        toolRadius: tool,
        edges: check.edges,
        isBackCut,
      }));
    }

    const values = [state.startZ, state.endX, state.radius, state.toolRadius];
    if (check.error) return formError(check.error);
    if (values.some(isInvalidNumber)) return formError('FIELD_INVALID');
    const numbers = requireNumbers(values);
    if (!numbers) return formError('FIELD_REQUIRED');
    if (state.shape === 'fillet') {
      return done(GCode.generateFillet({
        startZ: numbers[0],
        endX: numbers[1],
        radius: numbers[2],
        isConvex: state.convexity === 'convex',
        toolRadius: numbers[3],
        edges: check.edges,
        isBackCut,
      }));
    }
    return done(GCode.generateSphere({
      startZ: numbers[0],
      diameter: numbers[1],
      sphereRadius: numbers[2],
      toolRadius: numbers[3],
      edges: check.edges,
      isBackCut,
    }));
  }

  function calculateParting() {
    const shapeFields = state.shape === 'chamfer' ? [state.partingLength, state.partingAngle] : [state.partingSize];
    const values = [state.partDiameter, state.partEndZ, state.partingWidth, state.partingRadius, ...shapeFields];
    if ([...values, state.grooveX].some(isInvalidNumber)) return formError('FIELD_INVALID');
    const numbers = requireNumbers(values);
    if (!numbers) return formError('FIELD_REQUIRED');
    let edge;
    if (state.shape === 'chamfer') edge = { type: 'chamfer', length: numbers[4], angleDegrees: numbers[5] };
    else if (state.shape === 'fillet') edge = { type: 'fillet', radius: numbers[4] };
    else edge = { type: 'sphere', radius: numbers[4] };
    return done(GCode.generateParting({
      diameter: numbers[0],
      partEndZ: numbers[1],
      edge,
      toolWidth: numbers[2],
      toolRadius: numbers[3],
      grooveX: parseNumber(state.grooveX),
    }));
  }

  function calculateMilling() {
    const values = [state.millStockDiameter, state.millCutterDiameter, state.millClearance];
    if ([...values, state.millDepthX].some(isInvalidNumber)) return formError('FIELD_INVALID');
    const numbers = requireNumbers(values);
    if (!numbers) return formError('FIELD_REQUIRED');
    return done(GCode.generateMillingRetract({
      stockDiameter: numbers[0],
      cutterDiameter: numbers[1],
      clearance: numbers[2],
      depthX: parseNumber(state.millDepthX),
      yOnDiameter: state.millYMode === 'diameter',
    }));
  }

  // ---------------------------------------------------------------- Результат

  function clearOutcome() {
    if (plot) plot.destroy();
    plot = null;
    resultBox.replaceChildren();
  }

  function paragraph(className, text) {
    const element = document.createElement('p');
    element.className = className;
    element.textContent = text;
    return element;
  }

  function showOutcome(outcome) {
    clearOutcome();
    let content;
    if (outcome.formError) content = paragraph('error-text appear', MESSAGES[outcome.formError]);
    else if (!outcome.result.ok) content = paragraph('error-text appear', MESSAGES[outcome.result.problem] || outcome.result.problem);
    else if (outcome.result.kind === 'retract') content = retractCard(outcome.result);
    else content = successCard(outcome.result);
    resultBox.appendChild(content);
    if (plot) plot.draw();
    // Прокрутка к началу результата, а не в конец экрана: иначе сам код уезжает вверх.
    requestAnimationFrame(() => resultBox.scrollIntoView({ behavior: smoothScroll(), block: 'start' }));
  }

  const smoothScroll = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  function successCard(result) {
    const card = document.createElement('div');
    card.className = 'card appear';
    const code = result.blocks.join('\n');

    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.textContent = code;
    card.appendChild(pre);

    plot = new ToolpathPlot(result.preview);
    card.appendChild(plot.element);

    const c = result.contour;
    card.appendChild(paragraph('note', `На детали: X${format(c.startX)} Z${format(c.startZ)} → X${format(c.endX)} Z${format(c.endZ)}`));

    const edges = result.preview.edges;
    if (edges && !result.warnings.some(isInsertWarning)) {
      card.appendChild(paragraph('note', `Форма пластины подходит: вершина достаёт до всего контура. С задней стороны контур может быть наклонён к оси Z до ${format(edges.maxFallingAngle)}°.`));
    }
    result.warnings.forEach((warning) => card.appendChild(paragraph('warning', warningText(warning, result))));
    card.appendChild(paragraph('note', 'Проверьте код на симуляции или в холостом проходе перед первой деталью.'));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button outlined';
    copy.textContent = 'Копировать код';
    copy.addEventListener('click', () => copyText(code));
    card.appendChild(copy);
    return card;
  }

  function retractCard(result) {
    const card = document.createElement('div');
    card.className = 'card appear';
    const value = format(result.programY);

    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.textContent = `Y${value}\nY-${value}`;
    card.appendChild(pre);
    card.appendChild(paragraph('note', 'Отвод в любую сторону от оси: плюс или минус, куда удобнее по наладке.'));

    plot = new RetractSketch(result);
    card.appendChild(plot.element);

    const parts = result.aboveStock
      ? `радиус фрезы ${format(result.cutterR)} + зазор ${format(result.clearance)}`
      : `${result.depthX == null || result.depthR === 0 ? 'радиус заготовки' : 'полуширина заготовки на уровне торца фрезы'} ${format(result.halfWidth)} + радиус фрезы ${format(result.cutterR)} + зазор ${format(result.clearance)}`;
    card.appendChild(paragraph('note', `Центр фрезы на ${format(result.centerY)} мм от оси детали: ${parts}.`));
    card.appendChild(paragraph('note', result.yOnDiameter
      ? `Y на диаметр: в программе вдвое больше фактического сдвига, Y${value} это ${format(result.centerY)} мм.`
      : `Y на радиус: в программе фактический сдвиг, ${value} мм.`));
    if (result.aboveStock) {
      card.appendChild(paragraph('note', 'Торец фрезы остаётся выше заготовки: по X она её не достаёт, отвод по Y здесь только с запасом.'));
    }
    card.appendChild(paragraph('note', 'Проверьте первый подвод на станке на малой подаче или в холостом проходе.'));

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'button outlined';
    copy.textContent = 'Копировать Y';
    copy.addEventListener('click', () => copyText(`Y${value}`));
    card.appendChild(copy);
    return card;
  }

  async function copyText(text) {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (error) {
      // Без https или в старом браузере: запасной путь через выделение текста.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      try {
        copied = document.execCommand('copy');
      } catch (ignored) {
        copied = false;
      }
      area.remove();
    }
    showToast(copied ? 'Скопировано' : 'Не удалось скопировать: выделите код и скопируйте вручную');
  }

  let toastTimer = null;
  function showToast(text) {
    const toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  document.getElementById('calculate').addEventListener('click', () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    showOutcome(calculate());
  });

  render();

  // Офлайн-работа после первого открытия: в цеху интернет бывает не везде.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
