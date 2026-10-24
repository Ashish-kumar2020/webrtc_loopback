import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { VideoSource } from "./VideoSource";
import { createLoopBack } from "./webrtc";

type VideoProfile = "720p" | "360p";

type VideoProfileConfig = {
  width: number;
  height: number;
  frameRate: number;
};

type Measurement = {
  profile: VideoProfile;
  run: number;
  bitrateCapBps: number;
  codec: string;
  sentResolution: string;
  receivedResolution: string;
  averageBitrateKbps: number;
  receivedFps: number | null;
  framesDropped: number | null;
  durationMs: number;
  validSamples: number;
  measuredAt: string;
};

type VideoRtpReport = RTCStats & {
  type: "outbound-rtp" | "inbound-rtp";
  kind?: string;
  mediaType?: string;
  isRemote?: boolean;
  bytesSent?: number;
  timestamp: number;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  framesDropped?: number;
  codecId?: string;
};

type LoopbackConnection = Awaited<ReturnType<typeof createLoopBack>>;

const PROFILES: Record<VideoProfile, VideoProfileConfig> = {
  "720p": { width: 1280, height: 720, frameRate: 30 },
  "360p": { width: 640, height: 360, frameRate: 30 },
};

const WARMUP_DURATION_MS = 10_000;
const MEASUREMENT_DURATION_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1_000;
const MIN_VALID_SAMPLES = 5;

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred.";
}

function isVideoReport(
  report: RTCStats,
  type: "outbound-rtp" | "inbound-rtp",
): report is VideoRtpReport {
  const candidate = report as VideoRtpReport;

  return (
    candidate.type === type &&
    (candidate.kind === "video" || candidate.mediaType === "video") &&
    candidate.isRemote !== true &&
    typeof candidate.timestamp === "number"
  );
}

function getVideoReports(stats: RTCStatsReport) {
  const reports = Array.from(stats.values());

  const outbound = reports.find(
    (report) =>
      isVideoReport(report, "outbound-rtp") &&
      typeof report.bytesSent === "number",
  );

  const inbound = reports.find((report) =>
    isVideoReport(report, "inbound-rtp"),
  );

  const codecId =
    (inbound as VideoRtpReport | undefined)?.codecId ??
    (outbound as VideoRtpReport | undefined)?.codecId;

  const codecReport = codecId ? stats.get(codecId) : undefined;

  const codec =
    codecReport &&
    "mimeType" in codecReport &&
    typeof codecReport.mimeType === "string"
      ? codecReport.mimeType
      : "Not available";

  return {
    outbound: outbound as VideoRtpReport | undefined,
    inbound: inbound as VideoRtpReport | undefined,
    codec,
  };
}

function getResolution(
  report: VideoRtpReport | undefined,
  fallbackWidth?: number,
  fallbackHeight?: number,
): string {
  if (report?.frameWidth && report.frameHeight) {
    return `${report.frameWidth} × ${report.frameHeight}`;
  }

  if (fallbackWidth && fallbackHeight) {
    return `${fallbackWidth} × ${fallbackHeight}`;
  }

  return "Not available";
}

function downloadFile(
  filename: string,
  content: string,
  mimeType: string,
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportJson(measurements: Measurement[]) {
  downloadFile(
    "webrtc-statistics.json",
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        testEnvironment: "Local WebRTC loopback",
        warmupDurationMs: WARMUP_DURATION_MS,
        measurementDurationMs: MEASUREMENT_DURATION_MS,
        measurements,
      },
      null,
      2,
    ),
    "application/json",
  );
}

function exportCsv(measurements: Measurement[]) {
  const headers = [
    "Profile",
    "Run",
    "Bitrate Cap (bps)",
    "Codec",
    "Sent Resolution",
    "Received Resolution",
    "Average Bitrate (kbps)",
    "Received FPS",
    "Frames Dropped",
    "Duration (ms)",
    "Valid Samples",
    "Measured At",
  ];

  const escapeCsv = (value: unknown) =>
    `"${String(value ?? "Not available").replace(/"/g, '""')}"`;

  const rows = measurements.map((measurement) =>
    [
      measurement.profile,
      measurement.run,
      measurement.bitrateCapBps,
      measurement.codec,
      measurement.sentResolution,
      measurement.receivedResolution,
      measurement.averageBitrateKbps,
      measurement.receivedFps,
      measurement.framesDropped,
      measurement.durationMs,
      measurement.validSamples,
      measurement.measuredAt,
    ]
      .map(escapeCsv)
      .join(","),
  );

  downloadFile(
    "webrtc-comparison.csv",
    [headers.map(escapeCsv).join(","), ...rows].join("\r\n"),
    "text/csv;charset=utf-8",
  );
}

function App() {
  const [profile, setProfile] = useState<VideoProfile>("720p");
  const [sourceStream, setSourceStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("Not Connected");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [measurements, setMeasurements] = useState<Measurement[]>([]);

  const [latestStats, setLatestStats] = useState({
    codec: "Not available",
    sentResolution: "Not available",
    receivedResolution: "Not available",
    bitrateKbps: 0,
    receivedFps: null as number | null,
    framesDropped: null as number | null,
  });

  const receiverRef = useRef<HTMLVideoElement>(null);
  const connectionRef = useRef<LoopbackConnection | null>(null);
  const trackHandlerRef = useRef<((event: Event) => void) | null>(null);
  const measurementsRef = useRef<Measurement[]>([]);
  const operationIdRef = useRef(0);
  const measurementIdRef = useRef(0);
  const mountedRef = useRef(false);

  const selectedConfig = PROFILES[profile];

  const handleStreamReady = useCallback((stream: MediaStream) => {
    setSourceStream(stream);
  }, []);

  const saveMeasurement = useCallback((measurement: Measurement) => {
    const updated = [...measurementsRef.current, measurement];

    measurementsRef.current = updated;
    setMeasurements(updated);
  }, []);

  const removeTrackHandler = useCallback(() => {
    if (trackHandlerRef.current) {
      window.removeEventListener("webrtc-track", trackHandlerRef.current);
      trackHandlerRef.current = null;
    }
  }, []);

  const stopConnection = useCallback(() => {
    operationIdRef.current += 1;
    measurementIdRef.current += 1;

    removeTrackHandler();

    connectionRef.current?.close();
    connectionRef.current = null;

    if (receiverRef.current) {
      receiverRef.current.pause();
      receiverRef.current.srcObject = null;
    }

    setIsConnecting(false);
    setIsConnected(false);
    setIsTesting(false);
    setPhase("");
    setProgress(0);
    setStatus("Not Connected");
    setLatestStats({
      codec: "Not available",
      sentResolution: "Not available",
      receivedResolution: "Not available",
      bitrateKbps: 0,
      receivedFps: null,
      framesDropped: null,
    });
  }, [removeTrackHandler]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      operationIdRef.current += 1;
      measurementIdRef.current += 1;

      if (trackHandlerRef.current) {
        window.removeEventListener("webrtc-track", trackHandlerRef.current);
        trackHandlerRef.current = null;
      }

      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, []);

  async function startConnection() {
    if (!sourceStream || isConnecting || isConnected || isTesting) return;

    const operationId = ++operationIdRef.current;

    setIsConnecting(true);
    setStatus("Connecting...");
    setError("");

    removeTrackHandler();

    const handleTrack = (event: Event) => {
      if (
        !mountedRef.current ||
        operationIdRef.current !== operationId
      ) {
        return;
      }

      const stream = (event as CustomEvent<MediaStream>).detail;
      const video = receiverRef.current;

      if (!stream || !video) {
        setError("Received video stream is unavailable.");
        return;
      }

      video.srcObject = stream;

      void video.play().then(
        () => {
          if (
            !mountedRef.current ||
            operationIdRef.current !== operationId
          ) {
            return;
          }

          setStatus("Connected");
          setIsConnected(true);
          setError("");
        },
        (cause: unknown) => {
          if (!mountedRef.current) return;

          setError(getErrorMessage(cause));
          setStatus("Playback failed");
        },
      );
    };

    trackHandlerRef.current = handleTrack;
    window.addEventListener("webrtc-track", handleTrack);

    try {
      const connection = await createLoopBack(sourceStream, maxBitrate);

      if (
        !mountedRef.current ||
        operationIdRef.current !== operationId
      ) {
        connection.close();
        return;
      }

      connectionRef.current = connection;

      const updateConnectionStatus = () => {
        if (
          !mountedRef.current ||
          connectionRef.current !== connection
        ) {
          return;
        }

        const senderState = connection.senderPeer.connectionState;
        const receiverState = connection.receiverPeer.connectionState;

        if (senderState === "failed" || receiverState === "failed") {
          setStatus("Connection failed");
          setIsConnected(false);
          setError("The WebRTC connection failed.");
          return;
        }

        if (senderState === "connected" && receiverState === "connected") {
          setStatus("Connected");
          setIsConnected(true);
        }
      };

      connection.senderPeer.addEventListener(
        "connectionstatechange",
        updateConnectionStatus,
      );

      connection.receiverPeer.addEventListener(
        "connectionstatechange",
        updateConnectionStatus,
      );

      updateConnectionStatus();
    } catch (cause) {
      if (operationIdRef.current === operationId) {
        removeTrackHandler();
        setStatus("Connection failed");
        setError(getErrorMessage(cause));
      }
    } finally {
      if (mountedRef.current && operationIdRef.current === operationId) {
        setIsConnecting(false);
      }
    }
  }

  async function collectStatistics() {
    const connection = connectionRef.current;

    if (!connection || !isConnected) {
      setError("Establish a WebRTC connection first.");
      return;
    }

    try {
      const [senderStats, receiverStats] = await Promise.all([
        connection.senderPeer.getStats(),
        connection.receiverPeer.getStats(),
      ]);

      if (connectionRef.current !== connection) return;

      const sender = getVideoReports(senderStats);
      const receiver = getVideoReports(receiverStats);
      const video = receiverRef.current;

      setLatestStats({
        codec: receiver.codec,
        sentResolution: getResolution(
          sender.outbound,
          selectedConfig.width,
          selectedConfig.height,
        ),
        receivedResolution: getResolution(
          receiver.inbound,
          video?.videoWidth,
          video?.videoHeight,
        ),
        bitrateKbps: 0,
        receivedFps: receiver.inbound?.framesPerSecond ?? null,
        framesDropped: receiver.inbound?.framesDropped ?? null,
      });

      setError("");
    } catch (cause) {
      setError(getErrorMessage(cause));
    }
  }

  async function startMeasurement() {
    const connection = connectionRef.current;

    if (
      !connection ||
      !isConnected ||
      isTesting ||
      connection.senderPeer.connectionState !== "connected" ||
      connection.receiverPeer.connectionState !== "connected"
    ) {
      setError("Establish a connected WebRTC session before measuring.");
      return;
    }

    const measurementId = ++measurementIdRef.current;
    const selectedProfile = profile;
    const selectedCap = maxBitrate;
    const measuredAt = new Date().toISOString();

    setIsTesting(true);
    setError("");
    setProgress(0);

    const isActive = () =>
      mountedRef.current &&
      measurementIdRef.current === measurementId &&
      connectionRef.current === connection;

    try {
      setPhase("Warming up for 10 seconds");

      await new Promise<void>((resolve) =>
        setTimeout(resolve, WARMUP_DURATION_MS),
      );

      if (!isActive()) return;

      setPhase("Measuring for 30 seconds");

      const measurementStart = performance.now();

      let previousBytes: number | null = null;
      let previousTimestamp: number | null = null;
      let totalBytes = 0;
      let totalElapsedMs = 0;
      let validSamples = 0;

      while (performance.now() - measurementStart < MEASUREMENT_DURATION_MS) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, SAMPLE_INTERVAL_MS),
        );

        if (!isActive()) return;

        const senderStats = await connection.senderPeer.getStats();

        if (!isActive()) return;

        const sender = getVideoReports(senderStats);
        const report = sender.outbound;

        if (
          !report ||
          typeof report.bytesSent !== "number" ||
          typeof report.timestamp !== "number"
        ) {
          throw new Error("Valid outbound video statistics are unavailable.");
        }

        if (previousBytes !== null && previousTimestamp !== null) {
          const bytesDelta = report.bytesSent - previousBytes;
          const elapsed = report.timestamp - previousTimestamp;

          if (bytesDelta >= 0 && elapsed > 0) {
            totalBytes += bytesDelta;
            totalElapsedMs += elapsed;
            validSamples += 1;
          }
        }

        previousBytes = report.bytesSent;
        previousTimestamp = report.timestamp;

        setProgress(
          Math.min(
            100,
            Math.round(
              ((performance.now() - measurementStart) /
                MEASUREMENT_DURATION_MS) *
                100,
            ),
          ),
        );
      }

      if (!isActive()) return;

      if (validSamples < MIN_VALID_SAMPLES || totalElapsedMs <= 0) {
        throw new Error(
          `Insufficient valid samples: ${validSamples}. Please repeat the test.`,
        );
      }

      const averageBitrateKbps = Math.round(
        (totalBytes * 8) / totalElapsedMs,
      );

      const [senderStats, receiverStats] = await Promise.all([
        connection.senderPeer.getStats(),
        connection.receiverPeer.getStats(),
      ]);

      if (!isActive()) return;

      const sender = getVideoReports(senderStats);
      const receiver = getVideoReports(receiverStats);
      const video = receiverRef.current;

      const run =
        measurementsRef.current.filter(
          (measurement) => measurement.profile === selectedProfile,
        ).length + 1;

      const completedMeasurement: Measurement = {
        profile: selectedProfile,
        run,
        bitrateCapBps: selectedCap,
        codec: receiver.codec,
        sentResolution: getResolution(
          sender.outbound,
          PROFILES[selectedProfile].width,
          PROFILES[selectedProfile].height,
        ),
        receivedResolution: getResolution(
          receiver.inbound,
          video?.videoWidth,
          video?.videoHeight,
        ),
        averageBitrateKbps,
        receivedFps: receiver.inbound?.framesPerSecond ?? null,
        framesDropped: receiver.inbound?.framesDropped ?? null,
        durationMs: Math.round(totalElapsedMs),
        validSamples,
        measuredAt,
      };

      saveMeasurement(completedMeasurement);

      setLatestStats({
        codec: completedMeasurement.codec,
        sentResolution: completedMeasurement.sentResolution,
        receivedResolution: completedMeasurement.receivedResolution,
        bitrateKbps: completedMeasurement.averageBitrateKbps,
        receivedFps: completedMeasurement.receivedFps,
        framesDropped: completedMeasurement.framesDropped,
      });

      setPhase("Measurement complete");
    } catch (cause) {
      if (isActive()) {
        setError(getErrorMessage(cause));
        setPhase("Measurement failed");
      }
    } finally {
      if (measurementIdRef.current === measurementId) {
        setIsTesting(false);
        setProgress(0);
      }
    }
  }

  function changeProfile(nextProfile: VideoProfile) {
    if (nextProfile === profile || isTesting || isConnecting) return;

    stopConnection();
    setProfile(nextProfile);
  }

  function changeBitrate(value: string) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 100 || parsed > 6000) {
      setError("Enter a bitrate between 100 and 6000 kbps.");
      return;
    }

    if (isConnected || isConnecting || isTesting) {
      setError("Stop the current connection before changing the bitrate.");
      return;
    }

    setMaxBitrate(Math.round(parsed * 1000));
    setError("");
  }

  return (
    <main>
      <h1>WebRTC Profile Lab</h1>

      <p>
        Compare 720p and 360p capture profiles using a configurable sender
        bitrate cap.
      </p>

      <section>
        <h2>Capture Profile</h2>

        <label htmlFor="profile">Video profile:</label>{" "}
        <select
          id="profile"
          value={profile}
          disabled={isTesting || isConnecting}
          onChange={(event) =>
            changeProfile(event.target.value as VideoProfile)
          }
        >
          <option value="720p">720p — 1280 × 720</option>
          <option value="360p">360p — 640 × 360</option>
        </select>

        <p>Width: {selectedConfig.width}</p>
        <p>Height: {selectedConfig.height}</p>
        <p>Target frame rate: {selectedConfig.frameRate} FPS</p>
      </section>

      <section>
        <h2>Sender Bitrate Cap</h2>

        <label htmlFor="bitrate">Maximum bitrate (kbps):</label>{" "}
        <input
          id="bitrate"
          type="number"
          min={100}
          max={6000}
          step={100}
          value={maxBitrate / 1000}
          disabled={isConnected || isConnecting || isTesting}
          onChange={(event) => changeBitrate(event.target.value)}
        />

        <p>Configured cap: {maxBitrate.toLocaleString()} bps</p>
      </section>

      <section>
        <h2>Video Source</h2>

        <VideoSource
          width={selectedConfig.width}
          height={selectedConfig.height}
          frameRate={selectedConfig.frameRate}
          onStreamReady={handleStreamReady}
        />

        <h2>Received WebRTC Video</h2>

        <video
          ref={receiverRef}
          autoPlay
          muted
          playsInline
          style={{
            width: "100%",
            maxWidth: 640,
            background: "#111827",
          }}
        />

        <p role="status">Connection status: {status}</p>

        <button
          type="button"
          onClick={startConnection}
          disabled={!sourceStream || isConnecting || isConnected || isTesting}
        >
          {isConnecting ? "Connecting..." : "Start Connection"}
        </button>

        <button
          type="button"
          onClick={stopConnection}
          disabled={!isConnected && !isConnecting}
        >
          Stop Connection
        </button>
      </section>

      <section>
        <h2>WebRTC Statistics</h2>

        <button
          type="button"
          onClick={collectStatistics}
          disabled={!isConnected || isTesting}
        >
          Collect Statistics
        </button>

        <button
          type="button"
          onClick={startMeasurement}
          disabled={!isConnected || isTesting}
        >
          {isTesting ? "Measurement in progress..." : "Start Measurement"}
        </button>

        {isTesting && (
          <>
            <p>{phase}</p>
            <progress value={progress} max={100} />
            <p>{progress}%</p>
          </>
        )}

        <p>Codec: {latestStats.codec}</p>
        <p>Sent resolution: {latestStats.sentResolution}</p>
        <p>Received resolution: {latestStats.receivedResolution}</p>
        <p>Measured bitrate: {latestStats.bitrateKbps} kbps</p>
        <p>Received FPS: {latestStats.receivedFps ?? "Not available"}</p>
        <p>Frames dropped: {latestStats.framesDropped ?? "Not available"}</p>

        {error && <p role="alert">{error}</p>}
      </section>

      <section>
        <h2>Export Measurements</h2>

        <p>Completed runs: {measurements.length}</p>

        <button
          type="button"
          disabled={measurements.length === 0}
          onClick={() => exportJson(measurements)}
        >
          Export JSON
        </button>

        <button
          type="button"
          disabled={measurements.length === 0}
          onClick={() => exportCsv(measurements)}
        >
          Export CSV
        </button>
      </section>
    </main>
  );
}

export default App;