export type LoopBackConnection = {
  senderPeer: RTCPeerConnection;
  receiverPeer: RTCPeerConnection;
  close: () => void;
};

const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [],
};


export const DEFAULT_MAX_BITRATE = 6_000_000;

export async function createLoopBack(
  stream: MediaStream,
  maxBitrate: number = DEFAULT_MAX_BITRATE
): Promise<LoopBackConnection> {
  if (!stream || stream.getTracks().length === 0) {
    throw new Error("The video source stream is not available.");
  }

  if (!Number.isFinite(maxBitrate) || maxBitrate <= 0) {
    throw new Error("Maximum bitrate must be a positive number.");
  }

  const senderPeer = new RTCPeerConnection(RTC_CONFIGURATION);
  const receiverPeer = new RTCPeerConnection(RTC_CONFIGURATION);

  let closed = false;

  const pendingSenderCandidates: RTCIceCandidateInit[] = [];
  const pendingReceiverCandidates: RTCIceCandidateInit[] = [];

  const close = () => {
    if (closed) return;

    closed = true;

    senderPeer.onicecandidate = null;
    receiverPeer.onicecandidate = null;
    receiverPeer.ontrack = null;

    pendingSenderCandidates.length = 0;
    pendingReceiverCandidates.length = 0;

    senderPeer.close();
    receiverPeer.close();
  };

  const addCandidates = async (
    peer: RTCPeerConnection,
    candidates: RTCIceCandidateInit[],
  ) => {
    while (!closed && candidates.length > 0) {
      const candidate = candidates.shift();

      if (!candidate) continue;

      try {
        await peer.addIceCandidate(candidate);
      } catch (error) {
        if (!closed) {
          console.error("Failed to add ICE candidate:", error);
        }
      }
    }
  };

  try {
    senderPeer.onicecandidate = (event) => {
      if (closed || !event.candidate) return;

      const candidate = event.candidate.toJSON();

      if (receiverPeer.remoteDescription) {
        void receiverPeer.addIceCandidate(candidate).catch((error: unknown) => {
          if (!closed) {
            console.error("Failed to add candidate to receiver:", error);
          }
        });
      } else {
        pendingReceiverCandidates.push(candidate);
      }
    };

    receiverPeer.onicecandidate = (event) => {
      if (closed || !event.candidate) return;

      const candidate = event.candidate.toJSON();

      if (senderPeer.remoteDescription) {
        void senderPeer.addIceCandidate(candidate).catch((error: unknown) => {
          if (!closed) {
            console.error("Failed to add candidate to sender:", error);
          }
        });
      } else {
        pendingSenderCandidates.push(candidate);
      }
    };

    receiverPeer.ontrack = (event) => {
      if (closed) return;

      const receivedStream =
        event.streams[0] ?? new MediaStream([event.track]);

      window.dispatchEvent(
        new CustomEvent<MediaStream>("webrtc-track", {
          detail: receivedStream,
        }),
      );
    };

    for (const track of stream.getTracks()) {
      senderPeer.addTrack(track, stream);
    }

    const videoSender = senderPeer
      .getSenders()
      .find((sender) => sender.track?.kind === "video");

    if (!videoSender) {
      throw new Error("No video sender is available.");
    }

    const parameters = videoSender.getParameters();

    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}];
    }

    parameters.encodings[0].maxBitrate = maxBitrate;

    await videoSender.setParameters(parameters);

    if (closed) {
      throw new Error("Connection closed while configuring the sender.");
    }

    const offer = await senderPeer.createOffer();

    await senderPeer.setLocalDescription(offer);
    await receiverPeer.setRemoteDescription(offer);

    await addCandidates(receiverPeer, pendingReceiverCandidates);

    if (closed) {
      throw new Error("Connection closed during offer negotiation.");
    }

    const answer = await receiverPeer.createAnswer();

    await receiverPeer.setLocalDescription(answer);
    await senderPeer.setRemoteDescription(answer);

    await addCandidates(senderPeer, pendingSenderCandidates);

    if (closed) {
      throw new Error("Connection closed during answer negotiation.");
    }

    return {
      senderPeer,
      receiverPeer,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}