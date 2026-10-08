import { describe, expect, it, vi } from 'vitest';

import { appHost } from 'addons/webGPUPlayer/host/appHost';
import { appRouter } from 'addons/webGPUPlayer/host/appRouter';
import appSettings from 'addons/webGPUPlayer/host/appSettings';
import confirm from 'addons/webGPUPlayer/host/confirm';
import dashboardDefault, { pageClassOn, pageIdOn } from 'addons/webGPUPlayer/host/dashboard';
import globalize, {
    getCurrentLocale,
    loadAddonStrings,
    translate,
    translateHtml
} from 'addons/webGPUPlayer/host/globalize';
import { bindHostBridge, type HostPluginBag } from 'addons/webGPUPlayer/host/HostBridge';
import inputManagerDefault, { handleCommand, notify, off, on } from 'addons/webGPUPlayer/host/inputManager';
import loading, { hide, show } from 'addons/webGPUPlayer/host/loading';
import { PlaybackManager, playbackManager } from 'addons/webGPUPlayer/host/playbackManager';
import serverConnections from 'addons/webGPUPlayer/host/serverConnections';
import toast from 'addons/webGPUPlayer/host/toast';

// Translation files by locale, standing in for src/strings/<locale>.json; the bridge caches each locale, so every
// test uses its own locales
const translationFileState = vi.hoisted(() => ({
    files: new Map<string, Readonly<Record<string, string>>>(),
    requests: [] as string[]
}));

vi.mock('addons/webGPUPlayer/host/translationFiles', () => ({
    importTranslationFile: (locale: string): Promise<Readonly<Record<string, string>> | null> => {
        translationFileState.requests.push(locale);
        return Promise.resolve(translationFileState.files.get(locale) ?? null);
    }
}));

class FakePlaybackManager {
    play = vi.fn();
}

type FakeBag = { [Member in keyof HostPluginBag]: unknown };

function createBag(): FakeBag {
    return {
        appHost: { supports: vi.fn() },
        appRouter: { showVideoOsd: vi.fn() },
        appSettings: { get: vi.fn(), set: vi.fn() },
        confirm: vi.fn(),
        dashboard: {
            default: { setBackdropTransparency: vi.fn() },
            pageClassOn: vi.fn(),
            pageIdOn: vi.fn()
        },
        events: { on: vi.fn(), off: vi.fn(), trigger: vi.fn() },
        globalize: {
            getCurrentLocale: vi.fn(() => 'en-US'),
            translate: vi.fn((key: string) => `host:${key}`),
            translateHtml: vi.fn((html: string) => `host:${html}`)
        },
        inputManager: {
            default: { handleCommand: vi.fn() },
            handleCommand: vi.fn(),
            notify: vi.fn(),
            off: vi.fn(),
            on: vi.fn()
        },
        loading: { hide: vi.fn(), show: vi.fn() },
        playbackManager: new FakePlaybackManager(),
        ServerConnections: { getApiClient: vi.fn() },
        toast: vi.fn()
    };
}

function bind(bag: FakeBag): void {
    bindHostBridge(bag as unknown as HostPluginBag);
}

describe('bindHostBridge', () => {
    it('rejects a missing bag or a bag without a bridged dependency', () => {
        expect(() => bindHostBridge(undefined as unknown as HostPluginBag)).toThrow(TypeError);
        for (const memberName of [ 'playbackManager', 'ServerConnections', 'appSettings', 'dashboard', 'globalize' ]) {
            const bag = createBag();
            delete (bag as Partial<FakeBag>)[memberName as keyof FakeBag];
            expect(() => bind(bag)).toThrow(memberName);
        }
    });

    it('updates the live bindings that modules imported before construction read', () => {
        const bag = createBag();

        bind(bag);

        expect(playbackManager).toBe(bag.playbackManager);
        expect(PlaybackManager).toBe(FakePlaybackManager);
        expect(serverConnections).toBe(bag.ServerConnections);
        expect(appSettings).toBe(bag.appSettings);
        expect(appHost).toBe(bag.appHost);
        expect(appRouter).toBe(bag.appRouter);
        expect(loading).toBe(bag.loading);
        expect(toast).toBe(bag.toast);
        expect(confirm).toBe(bag.confirm);
        expect(dashboardDefault).toBe((bag.dashboard as { default: unknown }).default);
        expect(inputManagerDefault).toBe((bag.inputManager as { default: unknown }).default);

        const nextBag = createBag();
        bind(nextBag);
        expect(playbackManager).toBe(nextBag.playbackManager);
    });

    it('forwards named functions to the bound host modules', () => {
        const bag = createBag();
        bind(bag);
        const handler = (): void => undefined;

        show();
        hide();
        pageIdOn('viewshow', 'videoOsdPage', handler);
        pageClassOn('viewshow', 'page', handler);
        notify();
        on(document, handler);
        off(document, handler);
        handleCommand('play', {});

        const hostLoading = bag.loading as { hide: ReturnType<typeof vi.fn>, show: ReturnType<typeof vi.fn> };
        const hostDashboard = bag.dashboard as { pageClassOn: ReturnType<typeof vi.fn>, pageIdOn: ReturnType<typeof vi.fn> };
        const hostInputManager = bag.inputManager as Record<string, ReturnType<typeof vi.fn>>;
        expect(hostLoading.show).toHaveBeenCalledTimes(1);
        expect(hostLoading.hide).toHaveBeenCalledTimes(1);
        expect(hostDashboard.pageIdOn).toHaveBeenCalledWith('viewshow', 'videoOsdPage', handler);
        expect(hostDashboard.pageClassOn).toHaveBeenCalledWith('viewshow', 'page', handler);
        expect(hostInputManager.notify).toHaveBeenCalledTimes(1);
        expect(hostInputManager.on).toHaveBeenCalledWith(document, handler);
        expect(hostInputManager.off).toHaveBeenCalledWith(document, handler);
        expect(hostInputManager.handleCommand).toHaveBeenCalledWith('play', {});
    });
});

describe('globalize bridge', () => {
    it('serves the add-on strings without asking the host', () => {
        const bag = createBag();
        bind(bag);

        expect(translate('WebGPUPreferredVideoPlayer')).toBe('Preferred video player');
        expect(globalize.translate('WebGPUChooseAudioOutput')).toBe('Choose output');
        expect((bag.globalize as { translate: ReturnType<typeof vi.fn> }).translate).not.toHaveBeenCalled();
    });

    it('loads nothing for the source locale', async () => {
        translationFileState.requests.length = 0;
        bind(createBag());

        await loadAddonStrings();

        expect(translate('WebGPUResetAll')).toBe('Reset all');
        expect(translationFileState.requests).toEqual([]);
    });

    it('serves the current locale translation and falls back to the source per key', async () => {
        translationFileState.files.set('de', {
            WebGPUAudioOutput: '',
            WebGPUChooseAudioOutput: 'Ausgabe wählen',
            WebGPUUnnamedAudioOutput: 'Audioausgabe {0}'
        });
        translationFileState.requests.length = 0;
        const bag = createBag();
        (bag.globalize as { getCurrentLocale: () => string }).getCurrentLocale = (): string => 'de';
        bind(bag);

        await loadAddonStrings();

        expect(translate('WebGPUChooseAudioOutput')).toBe('Ausgabe wählen');
        expect(translate('WebGPUUnnamedAudioOutput', 2)).toBe('Audioausgabe 2');
        // An untranslated string is empty or absent, and both show the source text
        expect(translate('WebGPUAudioOutput')).toBe('Audio output');
        expect(translate('WebGPUResetAll')).toBe('Reset all');
        expect(translate('Auto')).toBe('host:Auto');
        expect(translationFileState.requests).toEqual([ 'de' ]);
    });

    it('falls back from a regional locale without a file to its base language', async () => {
        translationFileState.files.set('pt', { WebGPUResetAll: 'Redefinir tudo' });
        translationFileState.requests.length = 0;
        const bag = createBag();
        // The host normalizes locale names; the bridge does too
        (bag.globalize as { getCurrentLocale: () => string }).getCurrentLocale = (): string => 'pt_BR';
        bind(bag);

        await loadAddonStrings();

        expect(translate('WebGPUResetAll')).toBe('Redefinir tudo');
        expect(translationFileState.requests).toEqual([ 'pt-br', 'pt' ]);
    });

    it('loads a locale first seen after a language change', async () => {
        translationFileState.files.set('fr', { WebGPUResetAudio: 'Réinitialiser l’audio' });
        translationFileState.requests.length = 0;
        let locale = 'en-us';
        const bag = createBag();
        (bag.globalize as { getCurrentLocale: () => string }).getCurrentLocale = (): string => locale;
        bind(bag);

        locale = 'fr';
        // The source text serves until the translation arrives
        expect(translate('WebGPUResetAudio')).toBe('Reset audio');
        await loadAddonStrings();

        expect(translate('WebGPUResetAudio')).toBe('Réinitialiser l’audio');
        expect(translationFileState.requests).toEqual([ 'fr' ]);
    });

    it('substitutes add-on string arguments in the host locale', () => {
        const bag = createBag();
        bind(bag);

        expect(translate('WebGPUUnnamedAudioOutput', 3)).toBe('Audio output 3');
        expect(getCurrentLocale()).toBe('en-US');
    });

    it('falls back to the host dictionary for every other key', () => {
        const bag = createBag();
        bind(bag);

        expect(translate('Auto', 'argument')).toBe('host:Auto');
        expect((bag.globalize as { translate: ReturnType<typeof vi.fn> }).translate)
            .toHaveBeenCalledWith('Auto', 'argument');
    });

    it('expands add-on keys in templates before the host expands its own', () => {
        const bag = createBag();
        bind(bag);

        expect(translateHtml('<label>${WebGPUAudioOutput}</label><span>${Auto}</span>', 'core'))
            .toBe('host:<label>Audio output</label><span>${Auto}</span>');
        expect((bag.globalize as { translateHtml: ReturnType<typeof vi.fn> }).translateHtml)
            .toHaveBeenCalledWith('<label>Audio output</label><span>${Auto}</span>', 'core');
    });
});
