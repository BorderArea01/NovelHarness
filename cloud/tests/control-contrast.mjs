// Exact sRGB contrast for fixture assertions, not a whole-app WCAG audit.
function rgb(value) {
  if (/^#[a-f\d]{6}$/i.test(value))
    return value
      .slice(1)
      .match(/../g)
      .map((n) => parseInt(n, 16) / 255);
  const parts = value
    .match(/^rgba?\(([^)]+)\)$/)?.[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  if (
    !parts ||
    parts.length < 3 ||
    parts.some((n) => !Number.isFinite(n)) ||
    (parts.length > 3 && parts[3] !== 1)
  )
    throw new Error('Expected opaque sRGB color: ' + value);
  return parts.slice(0, 3).map((n) => n / 255);
}
function luminance(value) {
  return rgb(value)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
