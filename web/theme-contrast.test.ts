import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./style.css", import.meta.url), "utf8");

function tokens(selector: string) {
  const body = css.slice(css.indexOf(`${selector} {`)).split("}")[0]!;
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[\da-f]+);/gi)].map(([, name, value]) => [name!, value!]));
}

function rgba(hex: string) {
  const digits = hex.slice(1);
  const full = digits.length <= 4 ? [...digits].map(value => value + value).join("") : digits;
  return [0, 2, 4, 6].map((offset) => parseInt(full.slice(offset, offset + 2) || "ff", 16) / 255);
}

function luminance(rgb: number[]) {
  return rgb.slice(0, 3).reduce((sum, channel, index) => sum + [0.2126, 0.7152, 0.0722][index]! * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4), 0);
}

for (const theme of ["dark", "light"]) test(`${theme} preview zoom controls retain readable text over any canvas`, () => {
  const palette = { ...tokens(":root"), ...(theme === "light" ? tokens(':root[data-theme="light"]') : {}) };
  assert.match(css, /\.view-controls\s*\{[^}]*background:\s*var\(--ui-color-93\)/);
  const background = rgba(palette["--ui-color-93"]!);
  // Check the translucent bar over both extremes, not just a convenient canvas.
  for (const canvas of [0, 1]) {
    const surface = background.slice(0, 3).map(channel => channel * background[3]! + canvas * (1 - background[3]!));
    // Inherited label/percentage, icon-button, and active fit-to-canvas icon.
    for (const token of ["--ui-color-0", "--ui-color-39", "--ui-color-4"]) {
      const light = [luminance(rgba(palette[token]!)), luminance(surface)].sort((a, b) => a - b);
      const contrast = (light[1]! + 0.05) / (light[0]! + 0.05);
      assert.ok(contrast >= 4.5, `${theme} ${token} over canvas ${canvas}: ${contrast.toFixed(2)}:1`);
    }
  }
});
