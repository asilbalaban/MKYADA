// A faithful little Vision 6 OLED, drawn to a 128×64 canvas and upscaled with
// image-rendering: pixelated inside a device bezel — the same look as the
// screenshot mockups. Shows what pressing the wheel on a key looks like on the
// real screen (see lib/oled-draw + kind-registry.wheelPreview).

import { useEffect, useRef } from "react";
import { OLED_H, OLED_W, drawWheelScreen, type WheelPreview } from "../lib/oled-draw";

export function OledPreview({ preview, scale = 2 }: { preview: WheelPreview; scale?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current?.getContext("2d");
    if (c) drawWheelScreen(c, preview);
  }, [preview]);

  return (
    <div
      className="inline-block rounded-lg p-2"
      style={{ background: "linear-gradient(#20242c, #171a20)", border: "1px solid #2c313b" }}
    >
      <canvas
        ref={ref}
        width={OLED_W}
        height={OLED_H}
        style={{
          display: "block",
          width: OLED_W * scale,
          height: OLED_H * scale,
          imageRendering: "pixelated",
          borderRadius: 4,
          background: "#000",
        }}
      />
    </div>
  );
}
