// Copyright Epic Games, Inc. All Rights Reserved.

import { Config, Flags, NumericParameters } from '../Config/Config';
import { Logger } from '@epicgames-ps/lib-pixelstreamingcommon-ue5.8';

/**
 * Extra types for the HTMLElement
 */
declare global {
    interface HTMLElement {
        mozRequestPointerLock(): Promise<void>;
    }
}

/**
 * The video player html element
 */
export class VideoPlayer {
    // Common H.264 maximum encoding dimension. Streams beyond this commonly fail to encode.
    private static readonly maxEncoderDimension = 4096;

    private config: Config;
    private videoElement: HTMLVideoElement;
    private audioElement?: HTMLAudioElement;
    private canvasElement?: HTMLCanvasElement;
    private canvasCtx?: CanvasRenderingContext2D | null;
    private frameReader?: ReadableStreamDefaultReader<VideoFrame>;
    private orientationChangeTimeout: number;
    private lastTimeResized = new Date().getTime();

    onMatchViewportResolutionCallback: (width: number, height: number) => void;
    onResizePlayerCallback: () => void;
    resizeTimeoutHandle: number;

    /**
     * @param videoElementParent the html div the the video player will be injected into
     * @param config the applications configuration. We're interested in the startVideoMuted flag
     */
    constructor(videoElementParent: HTMLElement, config: Config) {
        this.videoElement = document.createElement('video');
        this.config = config;
        this.videoElement.id = 'streamingVideo';
        this.videoElement.disablePictureInPicture = true;
        this.videoElement.playsInline = true;
        this.videoElement.style.width = '100%';
        this.videoElement.style.height = '100%';
        this.videoElement.style.position = 'absolute';
        this.videoElement.style.pointerEvents = 'all';
        videoElementParent.appendChild(this.videoElement);

        this.onResizePlayerCallback = () => {
            Logger.Warning('Resolution changed, restyling player, did you forget to override this function?');
        };
        this.onMatchViewportResolutionCallback = () => {
            Logger.Warning(
                'Resolution changed and match viewport resolution is turned on, did you forget to override this function?'
            );
        };

        // set play for video (and audio)
        this.videoElement.onclick = () => {
            if (this.audioElement !== undefined && this.audioElement.paused) {
                void this.audioElement.play();
            }
            if (this.videoElement.paused) {
                void this.videoElement.play();
            }
        };

        this.videoElement.onloadedmetadata = () => {
            this.onVideoInitialized();
        };

        // set resize events to the windows if it is resized or its orientation is changed
        window.addEventListener('resize', () => this.resizePlayerStyle(), true);
        window.addEventListener('orientationchange', () => this.onOrientationChange());
    }

    public destroy() {
        this.stopLowLatencyRender();
        this.videoElement.src = '';
        this.videoElement.srcObject = null;
        this.videoElement.remove();

        if (this.audioElement) {
            this.audioElement.src = '';
            this.audioElement.srcObject = null;
            this.audioElement.remove();
        }
    }

    public setAudioElement(audioElement: HTMLAudioElement): void {
        this.audioElement = audioElement;
    }

    /**
     * Stops the low-latency canvas renderer and restores standard <video> visibility.
     */
    public stopLowLatencyRender(): void {
        if (this.frameReader) {
            void this.frameReader.cancel().catch(() => {
                // Ignore cancel errors during teardown
            });
            this.frameReader = undefined;
        }
        if (this.canvasElement) {
            this.canvasElement.remove();
            this.canvasElement = undefined;
            this.canvasCtx = undefined;
        }
        this.videoElement.style.opacity = '1';
    }

    /**
     * Attaches a MediaStreamTrackProcessor + desynchronized 2D canvas to bypass <video> compositor queueing
     * when supported by the browser and enabled via Flags.LowLatencyRender.
     */
    public attachLowLatencyTrack(track: MediaStreamTrack): boolean {
        if (track.kind !== 'video' || !this.config.isFlagEnabled(Flags.LowLatencyRender)) {
            return false;
        }

        type TrackProcessorCtor = new (init: { track: MediaStreamTrack }) => {
            readable: ReadableStream<VideoFrame>;
        };
        const TrackProcessor = (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor })
            .MediaStreamTrackProcessor;
        if (typeof TrackProcessor !== 'function') {
            return false;
        }

        this.stopLowLatencyRender();

        const parent = this.getVideoParentElement();
        if (!parent) {
            return false;
        }

        const canvas = document.createElement('canvas');
        canvas.id = 'streamingCanvas';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.position = 'absolute';
        canvas.style.objectFit = 'contain';
        canvas.style.pointerEvents = 'none';

        const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        if (!ctx) {
            return false;
        }

        parent.appendChild(canvas);
        this.canvasElement = canvas;
        this.canvasCtx = ctx;

        try {
            const processor = new TrackProcessor({ track });
            const reader = processor.readable.getReader();
            this.frameReader = reader;

            const renderLoop = async () => {
                let hasRenderedFirstFrame = false;
                try {
                    while (this.frameReader === reader) {
                        const { value: frame, done } = await reader.read();
                        if (done || !frame) {
                            break;
                        }
                        try {
                            if (this.frameReader === reader && this.canvasElement && this.canvasCtx) {
                                const w = frame.displayWidth || frame.codedWidth;
                                const h = frame.displayHeight || frame.codedHeight;
                                if (w > 0 && h > 0) {
                                    if (this.canvasElement.width !== w || this.canvasElement.height !== h) {
                                        this.canvasElement.width = w;
                                        this.canvasElement.height = h;
                                    }
                                    this.canvasCtx.drawImage(frame, 0, 0, w, h);
                                    if (!hasRenderedFirstFrame) {
                                        hasRenderedFirstFrame = true;
                                        this.videoElement.style.opacity = '0';
                                    }
                                }
                            }
                        } finally {
                            frame.close();
                        }
                    }
                } catch (err) {
                    if (this.frameReader === reader) {
                        Logger.Warning(`Low-latency canvas render loop ended: ${err}`);
                        this.stopLowLatencyRender();
                    }
                }
            };

            void renderLoop();
            Logger.Info('Low-latency MediaStreamTrackProcessor canvas renderer attached.');
            return true;
        } catch (err) {
            Logger.Warning(`Failed to initialize MediaStreamTrackProcessor, falling back to <video>: ${err}`);
            this.stopLowLatencyRender();
            return false;
        }
    }

    /**
     * Sets up the video element with any application config and plays the video element.
     * @returns A promise for if playing the video was successful or not.
     */
    play(): Promise<void> {
        this.videoElement.muted = this.config.isFlagEnabled(Flags.StartVideoMuted);
        this.videoElement.autoplay = this.config.isFlagEnabled(Flags.AutoPlayVideo);
        return this.videoElement.play();
    }

    /**
     * @returns True if the video element is paused.
     */
    isPaused(): boolean {
        return this.videoElement.paused;
    }

    /**
     * @returns - whether the video element is playing.
     */
    isVideoReady(): boolean {
        return this.videoElement.readyState !== undefined && this.videoElement.readyState > 0;
    }

    /**
     * @returns True if the video element has a valid video source (srcObject).
     */
    hasVideoSource(): boolean {
        return this.videoElement.srcObject !== undefined && this.videoElement.srcObject !== null;
    }

    /**
     * Get the current context of the html video element
     * @returns - the current context of the video element
     */
    getVideoElement(): HTMLVideoElement {
        return this.videoElement;
    }

    /**
     * Get the current context of the html video elements parent
     * @returns - the current context of the video elements parent
     */
    getVideoParentElement(): HTMLElement | undefined {
        return this.videoElement.parentElement ?? undefined;
    }

    /**
     * Set the Video Elements src object tracks to enable
     * @param enabled - Enable Tracks on the Src Object
     */
    setVideoEnabled(enabled: boolean) {
        if (this.canvasElement) {
            this.canvasElement.style.display = enabled ? '' : 'none';
        }
        // this is a temporary hack until type scripts video element is updated to reflect the need for tracks on a html video element
        const videoElement = this.videoElement;
        // Nothing to toggle until a stream has been attached (e.g. a freeze frame arriving before the first track).
        if (!videoElement.srcObject) {
            return;
        }
        (<MediaStream>videoElement.srcObject)
            .getTracks()
            .forEach((track: MediaStreamTrack) => (track.enabled = enabled));
    }

    /**
     * An override for when the video has been initialized with a srcObject
     */
    onVideoInitialized() {
        // Default Functionality: Do Nothing
    }

    /**
     * On the orientation change of a window clear the timeout
     */
    onOrientationChange() {
        clearTimeout(this.orientationChangeTimeout);
        this.orientationChangeTimeout = window.setTimeout(() => {
            this.resizePlayerStyle();
        }, 500);
    }

    /**
     * Resizes the player style based on the window height and width
     * @returns - nil if requirements are satisfied
     */
    resizePlayerStyle() {
        const videoElementParent = this.getVideoParentElement();

        if (!videoElementParent) {
            return;
        }

        this.updateVideoStreamSize();

        if (videoElementParent.classList.contains('fixed-size')) {
            this.onResizePlayerCallback();
            return;
        }

        // controls for resizing the player
        this.resizePlayerStyleToFillParentElement();
        this.onResizePlayerCallback();
    }

    /**
     * Resizes the player element to fill the parent element
     */
    resizePlayerStyleToFillParentElement() {
        const videoElementParent = this.getVideoParentElement();

        //Video is not initialized yet so set videoElementParent to size of parent element
        const styleWidth = '100%';
        const styleHeight = '100%';
        const styleTop = 0;
        const styleLeft = 0;
        videoElementParent.setAttribute(
            'style',
            'top: ' +
                styleTop +
                'px; left: ' +
                styleLeft +
                'px; width: ' +
                styleWidth +
                '; height: ' +
                styleHeight +
                '; cursor: default;'
        );
    }

    updateVideoStreamSize() {
        if (!this.config.isFlagEnabled(Flags.MatchViewportResolution)) {
            return;
        }

        const now = new Date().getTime();
        if (now - this.lastTimeResized > 300) {
            const videoElementParent = this.getVideoParentElement();
            if (!videoElementParent) {
                return;
            }

            const viewportResolutionScale = this.config.hasNumericSetting(NumericParameters.ViewportResScale)
                ? this.config.getNumericSettingValue(NumericParameters.ViewportResScale)
                : 1.0;

            const scaledWidth = Math.round(videoElementParent.clientWidth * viewportResolutionScale);
            const scaledHeight = Math.round(videoElementParent.clientHeight * viewportResolutionScale);

            if (
                scaledWidth > VideoPlayer.maxEncoderDimension ||
                scaledHeight > VideoPlayer.maxEncoderDimension
            ) {
                Logger.Warning(
                    `Requested stream resolution (${scaledWidth}x${scaledHeight}) exceeds the common H.264 encoder limit of ${VideoPlayer.maxEncoderDimension}x${VideoPlayer.maxEncoderDimension}; encoding may fail. Lower ViewportResScale or disable MatchViewportResolution.`
                );
            }

            this.onMatchViewportResolutionCallback(scaledWidth, scaledHeight);

            this.lastTimeResized = new Date().getTime();
        } else {
            Logger.Info('Resizing too often - skipping');
            clearTimeout(this.resizeTimeoutHandle);
            this.resizeTimeoutHandle = window.setTimeout(() => this.updateVideoStreamSize(), 100);
        }
    }
}
