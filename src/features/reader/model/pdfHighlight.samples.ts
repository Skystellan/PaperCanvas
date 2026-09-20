// Browser Range geometry: duplicate span/text boxes, raised/lowered glyphs,
// fraction numerator/denominator, and independent text lines/columns.
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
export const formulaSamples = [
  { name: "superscript x² + y", rects: [rect(40, 40, 14, 16), rect(40, 40, 14, 16), rect(54, 34, 7, 10), rect(63, 40, 28, 16)], boxes: [rect(40, 34, 51, 22)] },
  { name: "subscript xᵢ + y", rects: [rect(40, 40, 14, 16), rect(54, 50, 7, 10), rect(63, 40, 28, 16)], boxes: [rect(40, 40, 51, 20)] },
  { name: "stacked fraction", rects: [rect(40, 40, 24, 10), rect(40, 52, 24, 10), rect(66, 44, 12, 16)], boxes: [rect(40, 40, 38, 22)] },
  { name: "multiline equations", rects: [rect(40, 40, 24, 16), rect(64, 34, 7, 10), rect(40, 72, 24, 16), rect(64, 82, 7, 10)], boxes: [rect(40, 34, 31, 22), rect(40, 72, 31, 20)] },
  { name: "two columns", rects: [rect(40, 40, 100, 16), rect(140, 34, 7, 10), rect(340, 40, 100, 16), rect(440, 34, 7, 10)], boxes: [rect(40, 34, 107, 22), rect(340, 34, 107, 22)] },
  { name: "nearby ordinary lines", rects: [rect(40, 40, 100, 16), rect(40, 62, 100, 16)], boxes: [rect(40, 40, 100, 16), rect(40, 62, 100, 16)] },
];
