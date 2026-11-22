#version 300 es
precision highp float;

uniform vec2 uBarSize;
uniform float uBorderWidth;
uniform vec3 uThresholds;
uniform vec3 uColorRed;
uniform vec3 uColorOrange;
uniform vec3 uColorYellow;
uniform vec3 uColorGreen;
uniform vec3 uColorConstruction;
uniform vec3 uColorReload;
uniform vec3 uColorDeletion;
uniform float uTrackTint;   // brightness of the unfilled part, as a factor
uniform float uSolid;       // 1.0 = veterancy pip: fill solid with uSolidColor
uniform vec3 uSolidColor;

in vec2 vLocalPos;
flat in float vProgress;
flat in float vKind;        // 0 health, 1 construction, 2 reload, 3 deletion

out vec4 fragColor;

/**
 * A bar's hue says what it is; only health varies its hue with the fill.
 * Everything else keeps one flat color the whole way across, so a
 * just-started build never reads as a nearly-dead unit.
 */
vec3 barColor() {
  if (vKind < 0.5) {
    if (vProgress < uThresholds.x) return uColorRed;
    if (vProgress < uThresholds.y) return uColorOrange;
    if (vProgress < uThresholds.z) return uColorYellow;
    return uColorGreen;
  }
  if (vKind < 1.5) return uColorConstruction;
  if (vKind < 2.5) return uColorReload;
  return uColorDeletion;
}

void main() {
  // Veterancy pips are simple solid-filled rectangles (no border/threshold).
  if (uSolid > 0.5) {
    fragColor = vec4(uSolidColor, 1.0);
    return;
  }

  float x = vLocalPos.x;
  float y = vLocalPos.y;
  float w = uBarSize.x;
  float h = uBarSize.y;

  // Border on each side
  float bw = uBorderWidth;
  bool inBorder = x < bw || x > w - bw || y < bw || y > h - bw;

  // Colored fill region
  float fillWidth = vProgress * (w - 2.0 * bw);
  bool inFill = !inBorder && (x - bw) < fillWidth;

  vec3 color = barColor();

  if (inFill) {
    fragColor = vec4(color, 1.0);
  } else if (inBorder) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  } else {
    // The empty part of the track is a dark wash of the bar's own color, so
    // the bar still reads as "construction" / "reload" when it is near empty.
    fragColor = vec4(color * uTrackTint, 1.0);
  }
}
