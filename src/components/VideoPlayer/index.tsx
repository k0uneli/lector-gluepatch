'use client';

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import type { SeekTarget } from '@/components/YouTubePlayer';

export interface VideoPlayerHandle {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  isPaused: () => boolean;
}

interface VideoPlayerProps {
  src: string;
  seekTarget: SeekTarget | null;
  onTimeUpdate?: (currentMs: number) => void;
  onPause?: () => void;
  onPlay?: () => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  function VideoPlayer({ src, seekTarget, onTimeUpdate, onPause, onPlay }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);

    useImperativeHandle(ref, () => ({
      play: () => void videoRef.current?.play().catch(() => {}),
      pause: () => videoRef.current?.pause(),
      seekTo: (seconds: number) => {
        if (videoRef.current) videoRef.current.currentTime = Math.max(0, seconds);
      },
      isPaused: () => videoRef.current?.paused ?? true,
    }));

    useEffect(() => {
      if (!seekTarget || !videoRef.current) return;
      const video = videoRef.current;
      video.currentTime = Math.max(0, seekTarget.seconds);
      video.play().catch(() => {});
    }, [seekTarget]);

    const handleTimeUpdate = useCallback(() => {
      if (!videoRef.current || !onTimeUpdate) return;
      onTimeUpdate(Math.round(videoRef.current.currentTime * 1000));
    }, [onTimeUpdate]);

    return (
      <div
        data-testid="video-player"
        className="aspect-video w-full overflow-hidden rounded-xl border border-border bg-black"
      >
        <video
          ref={videoRef}
          className="h-full w-full"
          src={src}
          controls
          onTimeUpdate={handleTimeUpdate}
          onPause={onPause}
          onPlay={onPlay}
        />
      </div>
    );
  },
);

export default VideoPlayer;
