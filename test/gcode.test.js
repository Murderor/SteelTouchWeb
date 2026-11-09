/*
 * Те же ожидаемые значения, что в Kotlin-тестах core/gcode (посчитаны вручную, а не этим кодом).
 * Запуск: node --test web/test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/gcode.js');

const moves = (result) => result.blocks.slice(1);
const near = (expected, actual, delta = 1e-9) =>
  assert.ok(Math.abs(expected - actual) <= delta, `${actual} != ${expected}`);

const chamfer = ({ startX = 9, startZ = 0, endX = 10, endZ = 0.5, angle = null, length = null, toolRadius = 0.2, edges = null, isBackCut = false } = {}) =>
  G.generateChamfer({ startX, startZ, endX, endZ, angleDegrees: angle, length, toolRadius, edges, isBackCut });

const fillet = ({ startZ = 0, endX = 10, radius = 1, isConvex = true, toolRadius = 0.2, edges = null, isBackCut = false } = {}) =>
  G.generateFillet({ startZ, endX, radius, isConvex, toolRadius, edges, isBackCut });

const parting = (edge, grooveX = null) =>
  G.generateParting({ diameter: 10, partEndZ: 20, edge, toolWidth: 2, toolRadius: 0.2, grooveX });

test('format', () => {
  assert.equal(G.format(10), '10.0');
  assert.equal(G.format(0), '0.0');
  assert.equal(G.format(0.5), '0.5');
  assert.equal(G.format(-0.1172), '-0.117');
  assert.equal(G.format(1.2345), '1.235');
  assert.equal(G.format(99.9999), '100.0');
  assert.equal(G.format(-0.0001), '0.0');
  assert.equal(G.format(-0), '0.0');
  assert.equal(G.format(1e-10), '0.0');
});

test('parseNumber', () => {
  assert.equal(G.parseNumber(' 1,5 '), 1.5);
  assert.equal(G.parseNumber(''), null);
  assert.equal(G.parseNumber('-0.2'), -0.2);
  assert.equal(G.parseNumber('abc'), null);
  assert.equal(G.isInvalidNumber('1..2'), true);
  assert.equal(G.isInvalidNumber(''), false);
});

test('chamfer', () => {
  assert.deepEqual(moves(chamfer()), ['G01 X8.766 Z0.0', 'G01 X10.0 Z0.617']);
  assert.deepEqual(moves(chamfer({ toolRadius: 0 })), ['G01 X9.0 Z0.0', 'G01 X10.0 Z0.5']);
  const startX = 10 - 2 * 1 * 0.57735026919;
  assert.deepEqual(moves(chamfer({ startX, endZ: 1 })), ['G01 X8.676 Z0.0', 'G01 X10.0 Z1.146']);
  assert.deepEqual(moves(chamfer({ startX: 10, endX: 9 })), ['G01 X10.566 Z0.0', 'G01 X9.0 Z0.783']);
  near(10, chamfer({ endX: null, angle: 45 }).contour.endX);
  near(9, chamfer({ startX: null, angle: 45 }).contour.startX);
  near(0.5, chamfer({ endZ: null, length: 0.5 }).contour.endZ);
  near(0, chamfer({ startZ: null, angle: 45 }).contour.startZ);
  const c = chamfer({ endX: null, endZ: null, angle: 45, length: 0.5 }).contour;
  near(9, c.startX); near(0, c.startZ); near(10, c.endX); near(0.5, c.endZ);
  assert.ok(chamfer({ angle: 45, length: 0.5 }).ok);
});

test('chamfer problems', () => {
  const p = (o) => chamfer(o).problem;
  assert.equal(p({ endX: null }), 'NOT_ENOUGH_DATA');
  assert.equal(p({ startX: null, endX: null, angle: 45 }), 'NOT_ENOUGH_DATA');
  assert.equal(p({ startZ: null, endZ: null, angle: 45 }), 'NOT_ENOUGH_DATA');
  assert.equal(p({ endX: null, endZ: null, length: 0.5 }), 'NOT_ENOUGH_DATA');
  assert.equal(p({ angle: 30 }), 'ANGLE_CONFLICT');
  assert.equal(p({ length: 0.8 }), 'LENGTH_CONFLICT');
  assert.equal(p({ angle: 90 }), 'ANGLE_OUT_OF_RANGE');
  assert.equal(p({ angle: 0 }), 'ANGLE_OUT_OF_RANGE');
  assert.equal(p({ length: -1 }), 'NON_POSITIVE_LENGTH');
  assert.equal(p({ startZ: 1, endZ: 0.5 }), 'Z_NOT_INCREASING');
  assert.equal(p({ endZ: 0 }), 'Z_NOT_INCREASING');
  assert.equal(p({ endX: 9 }), 'X_NOT_CHANGING');
  assert.equal(p({ startX: -1 }), 'NEGATIVE_X');
  assert.equal(p({ toolRadius: -0.1 }), 'NEGATIVE_TOOL_RADIUS');
  assert.equal(p({ startX: null, endX: 0.4, endZ: 0.5, angle: 45 }), 'NEGATIVE_X');
});

test('chamfer warnings', () => {
  assert.ok(chamfer({ startX: 10, endX: 9 }).warnings.includes('TRAILING_EDGE_CONTACT'));
  const center = chamfer({ startX: 0, endX: 1 });
  assert.deepEqual(center.warnings, ['X_BELOW_ZERO']);
  assert.equal(moves(center)[0], 'G01 X-0.234 Z0.0');
});

test('fillet', () => {
  assert.deepEqual(moves(fillet()), ['G01 X7.6 Z0.0', 'G02 X10.0 Z1.2 R1.2']);
  assert.deepEqual(moves(fillet({ startZ: 2.5, endX: 20, radius: 3, toolRadius: 0.4 })), ['G01 X13.2 Z2.5', 'G02 X20.0 Z5.9 R3.4']);
  assert.deepEqual(moves(fillet({ startZ: 5, isConvex: false })), ['G01 X8.0 Z5.0', 'G01 X8.0 Z5.2', 'G03 X9.6 Z6.0 R0.8', 'G01 X10.0 Z6.0']);
  assert.deepEqual(moves(fillet({ radius: 2, isConvex: false, toolRadius: 0.5 })), ['G01 X6.0 Z0.0', 'G01 X6.0 Z0.5', 'G03 X9.0 Z2.0 R1.5', 'G01 X10.0 Z2.0']);
  assert.deepEqual(moves(fillet({ toolRadius: 0 })), ['G01 X8.0 Z0.0', 'G02 X10.0 Z1.0 R1.0']);
  assert.deepEqual(moves(fillet({ isConvex: false, toolRadius: 0 })), ['G01 X8.0 Z0.0', 'G03 X10.0 Z1.0 R1.0']);
  assert.deepEqual(fillet({ startZ: 2.5, endX: 20, radius: 3 }).contour, { startX: 14, startZ: 2.5, endX: 20, endZ: 5.5 });
  const center = fillet({ endX: 2 });
  assert.equal(moves(center)[0], 'G01 X-0.4 Z0.0');
  assert.deepEqual(center.warnings, ['X_BELOW_ZERO']);
});

test('fillet problems', () => {
  const p = (o) => fillet(o).problem;
  assert.equal(p({ endX: 1 }), 'RADIUS_TOO_LARGE_FOR_DIAMETER');
  assert.equal(p({ endX: 1, isConvex: false }), 'RADIUS_TOO_LARGE_FOR_DIAMETER');
  assert.equal(p({ radius: 0 }), 'NON_POSITIVE_RADIUS');
  assert.equal(p({ endX: -1 }), 'NEGATIVE_X');
  assert.equal(p({ toolRadius: -0.1 }), 'NEGATIVE_TOOL_RADIUS');
  assert.equal(p({ isConvex: false, toolRadius: 1 }), 'TOOL_RADIUS_TOO_LARGE');
  assert.equal(p({ isConvex: false, toolRadius: 1.5 }), 'TOOL_RADIUS_TOO_LARGE');
});

test('first move keeps start Z, last move ends on entered X', () => {
  const cases = [
    [chamfer(), 'Z0.0'], [chamfer({ startZ: 2.5, endZ: 3 }), 'Z2.5'], [chamfer({ startX: 10, endX: 9 }), 'Z0.0'],
    [fillet(), 'Z0.0'], [fillet({ startZ: 2.5, endX: 20, radius: 3, toolRadius: 0.4 }), 'Z2.5'],
    [fillet({ startZ: 5, isConvex: false }), 'Z5.0'], [fillet({ startZ: 5, endX: 14, radius: 2, isConvex: false }), 'Z5.0'],
    [fillet({ startZ: -0.2 }), 'Z-0.2'],
  ];
  cases.forEach(([result, z]) => assert.ok(moves(result)[0].endsWith(z)));
  [
    [fillet(), 'X10.0'], [fillet({ radius: 0.5 }), 'X10.0'], [fillet({ toolRadius: 0.8 }), 'X10.0'],
    [fillet({ startZ: 5, isConvex: false }), 'X10.0'], [fillet({ endX: 6, radius: 2, isConvex: false, toolRadius: 0.4 }), 'X6.0'],
    [chamfer({ startX: 10, endX: 9 }), 'X9.0'], [chamfer(), 'X10.0'],
  ].forEach(([result, x]) => assert.ok(` ${moves(result).at(-1)} `.includes(` ${x} `)));
});

test('back cut', () => {
  assert.deepEqual(moves(chamfer({ isBackCut: true })), ['G01 X10.0 Z0.617', 'G01 X8.766 Z0.0']);
  assert.deepEqual(moves(fillet({ isBackCut: true })), ['G01 X10.0 Z1.2', 'G03 X7.6 Z0.0 R1.2']);
  assert.deepEqual(moves(fillet({ isBackCut: true, isConvex: false })), ['G01 X10.0 Z1.0', 'G01 X9.6 Z1.0', 'G02 X8.0 Z0.2 R0.8', 'G01 X8.0 Z0.0']);
  assert.equal(fillet({ isBackCut: true }).blocks[0], '(BACK CONVEX R1.0 TOOL R0.2)');
  const forward = fillet().preview.programmed;
  const back = fillet({ isBackCut: true }).preview.programmed;
  [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
    near(forward.pointAt(1 - f).z, back.pointAt(f).z, 1e-6);
    near(forward.pointAt(1 - f).r, back.pointAt(f).r, 1e-6);
  });
  const backChamfer = chamfer({ isBackCut: true });
  assert.deepEqual(backChamfer.contour, chamfer().contour);
  assert.deepEqual([backChamfer.preview.contour.start, backChamfer.preview.contour.end], [{ z: 0.5, r: 5 }, { z: 0, r: 4.5 }]);
  assert.equal(chamfer({ startZ: 1, endZ: 0, isBackCut: true }).problem, 'Z_NOT_INCREASING');
});

test('insert designations', () => {
  const d = G.parseInsert('DCMT 11T304');
  assert.equal(d.shape, 'D'); assert.equal(d.noseAngle, 55); assert.equal(d.clearanceAngle, 7); near(0.4, d.noseRadius);
  near(0.2, G.parseInsert('ccgt09t302').noseRadius);
  near(0.8, G.parseInsert('CCMT 060208-PM').noseRadius);
  near(0, G.parseInsert('VCGT 110300').noseRadius);
  assert.equal(G.parseInsert('ССМТ 060204').noseAngle, 80);
  near(0.4, G.parseInsert('DCMT 21.51').noseRadius);
  assert.equal(G.parseInsert('DCMT').noseRadius, null);
  const round = G.parseInsert('RCMT 0602M0');
  assert.equal(round.noseAngle, null); near(3, round.noseRadius);
  ['', 'DCM', 'ZCMT 11T304', 'DCMT 11T3', 'DCMT 0602M0'].forEach((code) => assert.equal(G.parseInsert(code), null));
  near(2, G.parsePartingWidth('MGMN200-G'));
  near(1.5, G.parsePartingWidth('mgmn 150'));
  near(3, G.parsePartingWidth('MRMN300'));
  assert.equal(G.parsePartingWidth('DCMT 11T304'), null);
});

test('tool edges', () => {
  near(32, new G.ToolEdges(93, 55).trailingAngle);
  near(5, new G.ToolEdges(95, 80).trailingAngle);
  assert.equal(new G.ToolEdges(120, 80).isPossible, false);
  const E = (a, b) => new G.ToolEdges(a, b);
  assert.deepEqual(chamfer({ edges: E(93, 55) }).blocks, chamfer().blocks);
  assert.deepEqual(chamfer({ startX: 10, endX: 9, endZ: 1.072, edges: E(93, 55) }).warnings, []);
  assert.deepEqual(chamfer({ startX: 10, endX: 9, endZ: 1.072, edges: E(95, 80) }).warnings, ['INSERT_TRAILING_EDGE']);
  assert.deepEqual(chamfer({ startX: 10, endX: 9, endZ: 0.866 }).warnings, ['TRAILING_EDGE_CONTACT']);
  assert.deepEqual(chamfer({ endZ: 0.289, edges: E(45, 90) }).warnings, ['INSERT_LEAD_EDGE']);
  assert.deepEqual(chamfer({ endZ: 0.289, edges: E(75, 90) }).warnings, []);
  assert.deepEqual(fillet({ edges: E(93, 55) }).warnings, []);
  assert.deepEqual(fillet({ edges: E(93, 55), isConvex: false }).warnings, []);
  assert.deepEqual(fillet({ edges: E(75, 90) }).warnings, ['INSERT_LEAD_EDGE']);
  assert.deepEqual(fillet({ edges: E(90, 90) }).warnings, ['INSERT_TRAILING_EDGE']);
  const outline = E(90, 90).outline({ z: 0, r: 0 }, 1, 5);
  const close = (e, a) => assert.ok(Math.abs(e.z - a.z) < 1e-6 && Math.abs(e.r - a.r) < 1e-6);
  close({ z: -5, r: -1 }, outline[0]);
  close({ z: 0, r: -1 }, outline[1]);
  close({ z: 1, r: 0 }, outline.at(-2));
  close({ z: 1, r: 5 }, outline.at(-1));
});

test('parting', () => {
  const ch = parting({ type: 'chamfer', length: 0.5, angleDegrees: 45 });
  assert.deepEqual(ch.blocks, [
    '(PART-OFF CHAMFER Z0.5 A45.0 W2.0 TOOL R0.2)', 'G01 X11.0 Z22.0', 'G01 X8.366 Z22.0', 'G01 X11.0 Z22.0',
    'G01 X11.0 Z21.383', 'G01 X10.0 Z21.383', 'G01 X8.766 Z22.0', 'G01 X-0.4 Z22.0',
  ]);
  assert.deepEqual(ch.contour, { startX: 10, startZ: 19.5, endX: 9, endZ: 20 });
  assert.deepEqual(ch.warnings, []);
  assert.deepEqual(parting({ type: 'fillet', radius: 1 }).blocks, [
    '(PART-OFF CONVEX R1.0 W2.0 TOOL R0.2)', 'G01 X11.0 Z22.0', 'G01 X7.2 Z22.0', 'G01 X11.0 Z22.0',
    'G01 X11.0 Z20.8', 'G01 X10.0 Z20.8', 'G02 X7.6 Z22.0 R1.2', 'G01 X-0.4 Z22.0',
  ]);
  const sp = parting({ type: 'sphere', radius: 10 });
  assert.deepEqual(sp.blocks, [
    '(PART-OFF SPHERE SR10.0 W2.0 TOOL R0.2)', 'G01 X11.0 Z22.0', 'G01 X2.45 Z22.0', 'G01 X11.0 Z22.0',
    'G01 X11.0 Z20.576', 'G01 X10.0 Z20.576', 'G01 X9.8 Z20.633', 'G02 X-0.4 Z22.0 R10.2',
  ]);
  near(10 + Math.sqrt(75), sp.contour.startZ);
  const chEdge = { type: 'chamfer', length: 0.5, angleDegrees: 45 };
  const deep = parting(chEdge, 8);
  assert.equal(deep.blocks[2], 'G01 X8.0 Z22.0');
  assert.deepEqual(deep.warnings, []);
  assert.deepEqual(parting(chEdge, 9).warnings, ['GROOVE_SHALLOW']);
});

test('parting problems', () => {
  const base = { diameter: 10, partEndZ: 20, edge: { type: 'fillet', radius: 1 }, toolWidth: 2, toolRadius: 0.2, grooveX: null };
  const p = (o) => G.generateParting({ ...base, ...o }).problem;
  assert.equal(p({ toolWidth: 0 }), 'NON_POSITIVE_WIDTH');
  assert.equal(p({ toolRadius: 1.2 }), 'TOOL_RADIUS_TOO_LARGE_FOR_WIDTH');
  assert.equal(p({ diameter: 0 }), 'NON_POSITIVE_DIAMETER');
  assert.equal(p({ edge: { type: 'fillet', radius: 5 } }), 'PARTING_EDGE_TOO_DEEP');
  assert.equal(p({ edge: { type: 'chamfer', length: 6, angleDegrees: 45 } }), 'PARTING_EDGE_TOO_DEEP');
  assert.equal(p({ edge: { type: 'sphere', radius: 4 } }), 'SPHERE_RADIUS_TOO_SMALL');
  assert.equal(p({ grooveX: 0 }), 'GROOVE_DEPTH_INVALID');
  assert.equal(p({ grooveX: 10 }), 'GROOVE_DEPTH_INVALID');
});

test('turned sphere', () => {
  const s = G.generateSphere({ startZ: 0, diameter: 10, sphereRadius: 10, toolRadius: 0.4 });
  assert.deepEqual(s.blocks, ['(SPHERE SR10.0 TOOL R0.4)', 'G01 X-0.8 Z0.0', 'G02 X9.6 Z1.393 R10.4', 'G01 X10.0 Z1.509']);
  assert.deepEqual(s.warnings, ['X_BELOW_ZERO']);
  const arc = s.preview.programmed.segments.find((seg) => seg.kind === 'arc');
  const contour = s.preview.contour;
  for (let i = 0; i <= 40; i++) {
    const c = s.preview.noseCenter(arc.pointAt(i / 40));
    near(0.4, Math.abs(Math.hypot(c.z - contour.center.z, c.r - contour.center.r) - contour.radius), 0.002);
  }
  const back = G.generateSphere({ startZ: 0, diameter: 10, sphereRadius: 10, toolRadius: 0.4, isBackCut: true });
  assert.deepEqual(back.blocks, ['(BACK SPHERE SR10.0 TOOL R0.4)', 'G01 X10.0 Z1.509', 'G01 X9.6 Z1.393', 'G03 X-0.8 Z0.0 R10.4']);
  assert.deepEqual(back.warnings, ['X_BELOW_ZERO']);
  assert.equal(G.generateSphere({ startZ: 0, diameter: 10, sphereRadius: 5, toolRadius: 0.4 }).blocks.at(-1), 'G02 X10.0 Z5.4 R5.4');
});

// Заготовка Ø10, фреза Ø6, зазор 1. До оси: 5 + 3 + 1 = 9, на диаметр Y18.
// Лыска до X8 (h = 4): полухорда √(25 − 16) = 3, центр 3 + 3 + 1 = 7, на диаметр Y14.
test('milling retract along Y', () => {
  const base = { stockDiameter: 10, cutterDiameter: 6, clearance: 1, yOnDiameter: true };
  const full = G.generateMillingRetract(base);
  near(9, full.centerY); near(18, full.programY);
  const flat = G.generateMillingRetract({ ...base, depthX: 8 });
  near(3, flat.halfWidth); near(7, flat.centerY); near(14, flat.programY);
  near(7, G.generateMillingRetract({ ...base, depthX: 8, yOnDiameter: false }).programY);
  // Торец ниже оси: та же полная ширина, что и до оси.
  near(9, G.generateMillingRetract({ ...base, depthX: -2 }).centerY);
  const above = G.generateMillingRetract({ ...base, depthX: 12 });
  assert.equal(above.aboveStock, true); near(4, above.centerY);
  assert.equal(G.generateMillingRetract({ ...base, stockDiameter: 0 }).problem, 'NON_POSITIVE_DIAMETER');
  assert.equal(G.generateMillingRetract({ ...base, cutterDiameter: 0 }).problem, 'NON_POSITIVE_CUTTER');
  assert.equal(G.generateMillingRetract({ ...base, clearance: -1 }).problem, 'NEGATIVE_CLEARANCE');
});

test('material before start', () => {
  assert.equal(chamfer().preview.materialBeforeStart, false);
  assert.equal(chamfer({ startX: 10, endX: 9 }).preview.materialBeforeStart, true);
  assert.equal(fillet().preview.materialBeforeStart, false);
  assert.equal(fillet({ startZ: 5, isConvex: false }).preview.materialBeforeStart, true);
});
