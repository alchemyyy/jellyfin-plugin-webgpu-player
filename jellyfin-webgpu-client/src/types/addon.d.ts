import type { TimingTraceControl } from '../TimingTraceControl';

/** Runtime configuration written by the server plugin's bootstrap script before the add-on loads */
type WebGPUPlayerAddonConfiguration = {
    // Absolute URL path of the add-on asset route, ending with a slash
    assetBaseURL?: string
};

export declare global {
    // Defined by webpack.config.js from the build info the engine's asset build writes
    const __WEBGPU_PLAYER_ASSET_KEY__: string;
    // Webpack's runtime public path; publicPath 'auto' resolves it from the entry module URL
    // eslint-disable-next-line @typescript-eslint/naming-convention -- webpack defines this free variable
    let __webpack_public_path__: string;

    interface Window {
        WebGPUPlayerConfig?: WebGPUPlayerAddonConfiguration
        // Installed by TimingTraceControl.ts for the console and for automation
        WebGPUPlayerTimingTrace?: TimingTraceControl
    }
}
