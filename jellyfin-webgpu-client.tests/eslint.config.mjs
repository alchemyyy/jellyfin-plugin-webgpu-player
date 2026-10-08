// @ts-check

// Lints the add-on's tests with the client's rules. ESLint only lints files below its config file's directory, so the
// tests need a config of their own; it reuses the client's, whose plugins resolve from the client's node_modules
import path from 'path';
import { addonSourceConfig, sharedConfigs } from '../jellyfin-webgpu-client/eslint.config.mjs';
import constants from '../jellyfin-webgpu-client/scripts/constants.js';

const { CLIENT_DIRECTORY } = constants;

export default [
    ...sharedConfigs,
    {
        files: [ '**/*.ts' ],
        ...addonSourceConfig,
        languageOptions: {
            ...addonSourceConfig.languageOptions,
            parserOptions: {
                // The tests belong to the client's TypeScript project, which no tsconfig beside them would find
                project: path.join(CLIENT_DIRECTORY, 'tsconfig.json'),
                tsconfigRootDir: CLIENT_DIRECTORY
            }
        }
    }
];
