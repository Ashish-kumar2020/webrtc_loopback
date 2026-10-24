import { useEffect, useRef } from "react";

type VideoSourceProps = {
  width: number;
  height: number;
  frameRate: number;
  onStreamReady: (stream: MediaStream) => void;
};

export const VideoSource = ({
  width,
  height,
  frameRate,
  onStreamReady,
}: VideoSourceProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) return;

    const stream = canvas.captureStream(frameRate);
    onStreamReady(stream);

    let animationFrame: number;
    let lastFrameTime = 0;

    const frameInterval = 1000 / frameRate;

    function draw(timestamp: number) {
      if (!canvas || !context) return;

      if (timestamp - lastFrameTime >= frameInterval) {
        lastFrameTime = timestamp;

        context.fillStyle = "#111827";
        context.fillRect(0, 0, width, height);

        for (let x = 0; x < width; x += 4) {
          context.fillStyle =
            x % 8 === 0 ? "#f8fafc" : "#64748b";

          context.fillRect(x, 0, 1, height);
        }

        const barWidth = Math.max(20, width / 12);
        const x =
          (timestamp * 0.15) % (width + barWidth) - barWidth;

        context.fillStyle = "#f97316";
        context.fillRect(
          x,
          height * 0.25,
          barWidth,
          height * 0.5,
        );

        context.fillStyle = "#22d3ee";
        context.font = `bold ${Math.max(18, width / 20)}px sans-serif`;

        context.fillText(
          `${width} × ${height} | ${frameRate} FPS`,
          16,
          height - 24,
        );
      }

      animationFrame = requestAnimationFrame(draw);
    }

    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      stream.getTracks().forEach((track) => track.stop());
    };
  }, [width, height, frameRate, onStreamReady]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        width: "100%",
        maxWidth: 640,
        height: "auto",
        border: "1px solid #64748b",
      }}
    />
  );
};