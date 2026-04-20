// colors.js — Color presets, conversion utilities, and palette definitions

// Beard-specific colour presets
export const BEARD_PRESETS = [
  { name: 'Black',         hex: '#0D0D0D' },
  { name: 'Dark Brown',    hex: '#2C1810' },
  { name: 'Medium Brown',  hex: '#5C3317' },
  { name: 'Auburn',        hex: '#7B2D00' },
  { name: 'Copper',        hex: '#B5400A' },
  { name: 'Blonde',        hex: '#C8A96E' },
  { name: 'Salt & Pepper', hex: '#848484' },
  { name: 'Silver',        hex: '#B4B4B4' },
  { name: 'White',         hex: '#E8E4DC' },
];

// Three hero shades featured in the Trending Shades section
export const TRENDING_SHADES = [
  { name: 'Natural Brown', hex: '#6B3A2A', category: 'trending', badge: 'Trending' },
  { name: 'Burgundy',      hex: '#6B0F1A', category: 'trending', badge: 'Popular'  },
  { name: 'Natural Black', hex: '#1A1A1A', category: 'trending', badge: 'Trending' },
];

export const COLOR_PRESETS = [
  // Natural blacks & browns
  { name: 'Jet Black',      hex: '#0A0A0A', category: 'natural' },
  { name: 'Soft Black',     hex: '#1C1C1C', category: 'natural' },
  { name: 'Espresso',       hex: '#2C1810', category: 'natural' },
  { name: 'Dark Brown',     hex: '#3B2314', category: 'natural' },
  { name: 'Chocolate',      hex: '#5C3317', category: 'natural' },
  { name: 'Chestnut',       hex: '#7B3F1E', category: 'natural' },
  { name: 'Medium Brown',   hex: '#8B5E3C', category: 'natural' },
  { name: 'Caramel',        hex: '#A0692A', category: 'natural' },
  { name: 'Warm Brown',     hex: '#B07D3A', category: 'natural' },
  // Blondes
  { name: 'Dark Blonde',    hex: '#C8A96E', category: 'blonde' },
  { name: 'Golden Blonde',  hex: '#D4A843', category: 'blonde' },
  { name: 'Honey Blonde',   hex: '#DAB86A', category: 'blonde' },
  { name: 'Light Blonde',   hex: '#E8D5A0', category: 'blonde' },
  { name: 'Platinum',       hex: '#F2EDDA', category: 'blonde' },
  { name: 'Ash Blonde',     hex: '#C8C0A0', category: 'blonde' },
  // Reds & coppers
  { name: 'Auburn',         hex: '#7B2D00', category: 'red' },
  { name: 'Copper',         hex: '#B5400A', category: 'red' },
  { name: 'Ginger',         hex: '#C8521A', category: 'red' },
  { name: 'Red',            hex: '#B01020', category: 'red' },
  { name: 'Burgundy',       hex: '#6B0F1A', category: 'red' },
  { name: 'Cherry',         hex: '#8B1020', category: 'red' },
  // Fashion colors
  { name: 'Rose Gold',      hex: '#E8A090', category: 'fashion' },
  { name: 'Dusty Pink',     hex: '#D4849A', category: 'fashion' },
  { name: 'Violet',         hex: '#5A2080', category: 'fashion' },
  { name: 'Purple',         hex: '#7B35A0', category: 'fashion' },
  { name: 'Ocean Blue',     hex: '#1A5080', category: 'fashion' },
  { name: 'Teal',           hex: '#1A7070', category: 'fashion' },
  { name: 'Silver Grey',    hex: '#A8A8B0', category: 'fashion' },
  { name: 'Pearl Grey',     hex: '#C8C8D0', category: 'fashion' },
];

// Warm undertone recommendations
export const WARM_RECOMMENDATIONS = [
  'Golden Blonde', 'Honey Blonde', 'Caramel', 'Copper', 'Ginger',
  'Auburn', 'Warm Brown', 'Chestnut', 'Rose Gold'
];

// Cool undertone recommendations
export const COOL_RECOMMENDATIONS = [
  'Ash Blonde', 'Platinum', 'Silver Grey', 'Pearl Grey', 'Burgundy',
  'Violet', 'Purple', 'Ocean Blue', 'Teal'
];

// Neutral undertone recommendations
export const NEUTRAL_RECOMMENDATIONS = [
  'Dark Brown', 'Chocolate', 'Medium Brown', 'Dark Blonde', 'Light Blonde',
  'Cherry', 'Rose Gold', 'Soft Black', 'Chestnut'
];

// ─── Conversion utilities ──────────────────────────────────────────────────

export function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

export function hexToRgb255(hex) {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return [h, s, l];
}

export function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b);
}

// RGB (0-1 each) -> CIE LAB
export function rgbToLab(r, g, b) {
  // Linearize
  const lin = v => v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92;
  const rl = lin(r), gl = lin(g), bl = lin(b);
  // RGB -> XYZ (D65)
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750) / 1.00000;
  const z = (rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [
    116 * f(y) - 16,
    500 * (f(x) - f(y)),
    200 * (f(y) - f(z)),
  ];
}

export function getColorByName(name) {
  return COLOR_PRESETS.find(c => c.name === name);
}

export function getRecommendationsByUndertone(undertone) {
  const names = undertone === 'warm' ? WARM_RECOMMENDATIONS
    : undertone === 'cool' ? COOL_RECOMMENDATIONS
    : NEUTRAL_RECOMMENDATIONS;
  return names.map(n => getColorByName(n)).filter(Boolean);
}
