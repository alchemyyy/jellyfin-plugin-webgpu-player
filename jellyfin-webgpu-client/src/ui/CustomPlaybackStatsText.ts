import globalize from 'lib/globalize';

import type {
    CustomPlaybackState,
    CustomPlaybackTelemetry
} from 'webgpu-player/pipeline/CustomPlaybackControllerTypes';
import type {
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from 'webgpu-player/pipeline/DecodeWorkerProtocol';

// The stats overlay shows engine codes, which carry no text of their own; each code set is translated here.
// The exhaustive switches make a new engine code a type error until it has a string

/** Translates the custom playback controller's state. */
export function translatePlaybackState(state: CustomPlaybackState): string {
    switch (state) {
        case 'ended':
            return globalize.translate('WebGPUPlaybackStateEnded');
        case 'error':
            return globalize.translate('WebGPUPlaybackStateError');
        case 'fallback':
            return globalize.translate('WebGPUPlaybackStateFallback');
        case 'idle':
            return globalize.translate('WebGPUPlaybackStateIdle');
        case 'paused':
            return globalize.translate('WebGPUPlaybackStatePaused');
        case 'playing':
            return globalize.translate('WebGPUPlaybackStatePlaying');
        case 'seeking':
            return globalize.translate('WebGPUPlaybackStateSeeking');
        case 'starting':
            return globalize.translate('WebGPUPlaybackStateStarting');
        case 'stopping':
            return globalize.translate('WebGPUPlaybackStateStopping');
    }
}

/** Translates the state of the custom path's audio. */
export function translateAudioPath(audioPath: CustomPlaybackTelemetry['audioPath']): string {
    switch (audioPath) {
        case 'disabled':
            return globalize.translate('WebGPUAudioPathDisabled');
        case 'pending':
            return globalize.translate('WebGPUAudioPathPending');
        case 'ready':
            return globalize.translate('WebGPUAudioPathReady');
        case 'unavailable':
            return globalize.translate('WebGPUAudioPathUnavailable');
    }
}

/** Translates the video decoder the custom path chose. */
export function translateVideoDecoderBackend(backend: CustomDecodeVideoDecoderBackend): string {
    switch (backend) {
        case 'bundled-hevc':
            return globalize.translate('WebGPUVideoDecoderBundledHEVC');
        case 'ffmpeg-mpeg2-vc1':
            return globalize.translate('WebGPUVideoDecoderFFmpegMPEG2VC1');
        case 'native':
            return globalize.translate('WebGPUVideoDecoderNative');
        case 'openjpeg':
            return globalize.translate('WebGPUVideoDecoderOpenJPEG');
    }
}

/** Translates how decoded video reaches the presenter. */
export function translateVideoOutputMode(outputMode: CustomDecodeVideoOutputMode): string {
    switch (outputMode) {
        case 'raw-planes':
            return globalize.translate('WebGPUVideoOutputRawPlanes');
        case 'video-frame':
            return globalize.translate('WebGPUVideoOutputVideoFrame');
    }
}
