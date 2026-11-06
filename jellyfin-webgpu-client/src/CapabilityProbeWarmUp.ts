import { playbackManager } from 'components/playback/playbackmanager';
import {
    configureCustomDecodeCapabilityBackground,
    warmCustomDecodeCapabilities
} from 'webgpu-player/capability/CustomDecodeCapabilities';
import { getCustomPlaybackRuntimeAvailability } from 'webgpu-player/capability/CustomPlaybackRuntime';

import { getClientDefaults } from './ClientDefaults';
import {
    DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
    describeDecoderTestClient,
    normalizeDecoderTestBackgroundDevices,
    normalizeDecoderTestRules,
    parseDecoderTestRules,
    resolveDecoderTestTiming,
    type DecoderTestClient,
    type DecoderTestDecision,
    type DecoderTestRule,
    type DecoderTestRuleProblem
} from './DecoderTestTiming';
import { whenClientDefaultsSettled } from './ServerClientDefaults';
import { isStoredWebGPUCustomDecodeEnabled } from './WebGPUPlaybackPreferences';
import { loadWebGPUUserSettings } from './WebGPUUserSettings';

// The engine's capability probes, the decoder tests, started at add-on load so the first getDeviceProfile finds them done, on a client whose decoder test timing runs them in the background.
// The engine gates each step on idle time, on no negotiation being near, and on no media playing, and getDeviceProfile promotes what it needs.
// On a client that runs them only at playback, a playback runs the probes it needs, and a stored verdict that served a negotiation is not probed again behind it

const LOG_PREFIX = 'WebGPU decoder tests';

/** Returns whether the host has a playback open, whichever player plays it, paused or not. */
function isHostPlaybackActive(): boolean {
    try {
        return playbackManager.isPlaying() === true;
    } catch {
        // Before the host binds its PlaybackManager nothing plays through it
        return false;
    }
}

/** Reads the administrator's rules, skipping the lines that are no rule with one warning for all of them. */
function readDecoderTestRules(value: unknown): readonly DecoderTestRule[] {
    const { problems, rules } = parseDecoderTestRules(normalizeDecoderTestRules(value) ?? '');
    if (problems.length > 0) {
        const lines = problems.map((problem: DecoderTestRuleProblem): string => `${problem.line} (${problem.reason})`);
        console.warn(`${LOG_PREFIX}: rules-invalid: lines ${lines.join(', ')} ignored`);
    }
    return rules;
}

/** Names why a client runs the tests where it does, for the console. */
function describeDecision(decision: DecoderTestDecision, client: DecoderTestClient): string {
    switch (decision.reason) {
        case 'setting':
            return 'setting';
        case 'rule':
            return `rule on line ${String(decision.ruleLine)}`;
        case 'device-type':
            return `device type ${client.deviceType}`;
    }
}

/** Decides where this client runs the tests, from the user's setting and the server's latest defaults, and logs why. */
function decideDecoderTestTiming(): DecoderTestDecision {
    const defaults = getClientDefaults();
    const client = describeDecoderTestClient();
    const decision = resolveDecoderTestTiming(
        loadWebGPUUserSettings().playback.decoderTestTiming,
        client,
        normalizeDecoderTestBackgroundDevices(defaults.decoderTestBackgroundDevices) ?? DEFAULT_DECODER_TEST_BACKGROUND_DEVICES,
        readDecoderTestRules(defaults.decoderTestRules)
    );
    console.info(`${LOG_PREFIX}: ${decision.timing} (${describeDecision(decision, client)})`);
    return decision;
}

/**
 * Starts the capability probes in the background, unless custom decode is off or cannot run here, or this client runs them only at playback.
 * The decision waits for the server's defaults to settle, and a change of the setting applies from the next page load.
 * The engine skips the warm-up on a client that asks to save data or has few threads; resolves whether it started, and never rejects.
 */
export async function startCapabilityProbeWarmUp(): Promise<boolean> {
    // Background probes learn about playbacks at once, for the reruns of stored verdicts
    configureCustomDecodeCapabilityBackground({ isPlaybackActive: isHostPlaybackActive });
    if (!isStoredWebGPUCustomDecodeEnabled() || !getCustomPlaybackRuntimeAvailability().available) {
        return false;
    }
    await whenClientDefaultsSettled();
    const decision = decideDecoderTestTiming();
    configureCustomDecodeCapabilityBackground({
        isPlaybackActive: isHostPlaybackActive,
        refreshAfterUse: decision.timing === 'background'
    });
    return decision.timing === 'background' && warmCustomDecodeCapabilities();
}
