// @ts-check

// Adapted from Jellyfin Web's eslint.config.mjs: the same rules for the add-on, without the React plugins (the
// add-on has no JSX). Host modules resolve from the read-only Jellyfin Web source tree at JELLYFIN_WEB_DIR
import path from 'path';
import eslint from '@eslint/js';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import compat from 'eslint-plugin-compat';
import globals from 'globals';
// @ts-expect-error Missing type definition
import importPlugin from 'eslint-plugin-import';
import restrictedGlobals from 'confusing-browser-globals';
import sonarjs from 'eslint-plugin-sonarjs';
import stylistic from '@stylistic/eslint-plugin';
// eslint-disable-next-line import/no-unresolved
import tseslint from 'typescript-eslint';
import constants from './scripts/constants.js';
import jellyfinWeb from './scripts/jellyfin-web.js';

// Absolute directories only: npm packages from this package, host modules (components/..., utils/...) from the host
const MODULE_DIRECTORIES = [
    path.join(constants.CLIENT_DIRECTORY, 'node_modules'),
    jellyfinWeb.resolveJellyfinWebSourceDirectory()
];

/** Returns a directory from scripts/constants.js as a pattern relative to this package, such as src. */
function toClientPattern(directory) {
    return path.relative(constants.CLIENT_DIRECTORY, directory).split(path.sep).join('/');
}

const ADDON_SOURCE_PATTERN = toClientPattern(constants.ADDON_SOURCE_DIRECTORY);

/** Recommended sets, global ignores and style rules, shared with the tests' config (jellyfin-webgpu-client.tests/eslint.config.mjs) */
export const sharedConfigs = tseslint.config(
    eslint.configs.recommended,
    tseslint.configs.recommended,
    // @ts-expect-error Harmless type mismatch in dependency
    comments.recommended,
    compat.configs['flat/recommended'],
    importPlugin.flatConfigs.errors,
    sonarjs.configs.recommended,

    // Global ignores
    {
        ignores: [
            'node_modules',
            'coverage',
            // The WebGPU player engine and its hls.js fork are submodules that lint themselves
            toClientPattern(constants.WEBGPU_PLAYER_DIRECTORY),
            toClientPattern(constants.WEBGPU_PLAYER_HLS_DIRECTORY),
            '.idea',
            '.vscode'
        ]
    },

    // Global style rules
    {
        plugins: {
            '@stylistic': stylistic
        },
        extends: [ importPlugin.flatConfigs.typescript ],
        rules: {
            'array-callback-return': ['error', { 'checkForEach': true }],
            'curly': ['error', 'multi-line', 'consistent'],
            'default-case-last': 'error',
            // Aliases this resolver cannot see: the engine submodule and the add-on's own absolute specifiers (tsconfig
            // paths, which the typecheck verifies), and the hls.js fork submodule (webpack and Vitest aliases)
            'import/no-unresolved': ['error', { 'ignore': ['^webgpu-player/', '^addons/webGPUPlayer/', '^hls\\.js(/|$)'] }],
            'max-params': ['error', 7],
            'new-cap': [
                'error',
                {
                    'newIsCapExceptionPattern': String.raw`\.default$`
                }
            ],
            'no-duplicate-imports': 'error',
            'no-empty-function': 'error',
            'no-extend-native': 'error',
            'no-lonely-if': 'error',
            'no-nested-ternary': 'error',
            'no-redeclare': 'off',
            '@typescript-eslint/no-redeclare': ['error', { builtinGlobals: false }],
            'no-restricted-globals': ['error'].concat(restrictedGlobals),
            'no-restricted-properties': [
                'error',
                {
                    property: 'replaceChildren',
                    message: 'replaceChildren is not supported in all target browsers'
                }
            ],
            'no-return-assign': 'error',
            'no-return-await': 'error',
            'no-sequences': ['error', { 'allowInParentheses': false }],
            'no-shadow': 'off',
            '@typescript-eslint/no-shadow': 'error',
            'no-throw-literal': 'error',
            'no-undef-init': 'error',
            'no-unneeded-ternary': 'error',
            'no-unused-expressions': 'off',
            '@typescript-eslint/no-unused-expressions': ['error', { 'allowShortCircuit': true, 'allowTernary': true, 'allowTaggedTemplates': true }],
            'no-unused-private-class-members': 'error',
            '@typescript-eslint/no-unused-vars': 'error',
            'no-useless-rename': 'error',
            'no-useless-constructor': 'off',
            '@typescript-eslint/no-useless-constructor': 'error',
            'no-var': 'error',
            'no-void': ['error', { 'allowAsStatement': true }],
            'one-var': ['error', 'never'],
            'prefer-const': ['error', { 'destructuring': 'all' }],
            'prefer-promise-reject-errors': ['warn', { 'allowEmptyReject': true }],
            '@typescript-eslint/prefer-for-of': 'error',
            'radix': 'error',
            'yoda': 'error',

            'sonarjs/fixme-tag': 'warn',
            'sonarjs/todo-tag': 'off',
            'sonarjs/deprecation': 'off',
            'sonarjs/no-alphabetical-sort': 'warn',
            'sonarjs/no-inverted-boolean-check': 'error',
            'sonarjs/no-selector-parameter': 'off',
            'sonarjs/pseudo-random': 'warn',
            'sonarjs/aws-restricted-ip-admin-access': 'off',
            // TODO: Enable the following sonarjs rules and fix issues
            'sonarjs/no-duplicate-string': 'off',
            'sonarjs/no-nested-functions': 'warn',
            // NOTE: This rule is currently blowing up `TypeError: secretSignatures[fqn].forEach is not a function`
            'sonarjs/hardcoded-secret-signatures': 'off',

            // TODO: Replace with stylistic.configs.customize()
            '@stylistic/block-spacing': 'error',
            '@stylistic/brace-style': ['error', '1tbs', { 'allowSingleLine': true }],
            '@stylistic/comma-dangle': ['error', 'never'],
            '@stylistic/comma-spacing': 'error',
            '@stylistic/eol-last': 'error',
            '@stylistic/indent': ['error', 4, { 'SwitchCase': 1 }],
            '@stylistic/jsx-quotes': ['error', 'prefer-single'],
            '@stylistic/keyword-spacing': 'error',
            '@stylistic/max-statements-per-line': 'error',
            '@stylistic/no-floating-decimal': 'error',
            '@stylistic/no-mixed-spaces-and-tabs': 'error',
            '@stylistic/no-multi-spaces': 'error',
            '@stylistic/no-multiple-empty-lines': ['error', { 'max': 1 }],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/object-curly-spacing': ['error', 'always'],
            '@stylistic/operator-linebreak': ['error', 'before', { overrides: { '?': 'after', ':': 'after', '=': 'after' } }],
            '@stylistic/padded-blocks': ['error', 'never'],
            '@stylistic/quotes': ['error', 'single', { 'avoidEscape': true, 'allowTemplateLiterals': false }],
            '@stylistic/semi': 'error',
            '@stylistic/space-before-blocks': 'error',
            '@stylistic/space-infix-ops': 'error',

            '@typescript-eslint/no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: '@jellyfin/sdk/lib/generated-client',
                            message: 'Use direct file imports for tree-shaking',
                            allowTypeImports: true
                        },
                        {
                            name: '@jellyfin/sdk/lib/generated-client/api',
                            message: 'Use direct file imports for tree-shaking',
                            allowTypeImports: true
                        },
                        {
                            name: '@jellyfin/sdk/lib/generated-client/models',
                            message: 'Use direct file imports for tree-shaking',
                            allowTypeImports: true
                        },
                        {
                            name: '@mui/icons-material',
                            message: 'Use direct file imports for tree-shaking',
                            allowTypeImports: true
                        },
                        {
                            name: '@mui/material',
                            message: 'Use direct file imports for tree-shaking',
                            allowTypeImports: true
                        }
                    ]
                }
            ]
        }
    }
);

/** Settings and rules for the add-on's TypeScript and JavaScript, also applied to its tests; users add their own files pattern */
export const addonSourceConfig = {
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname
        },
        globals: {
            ...globals.browser,
            // Tizen globals
            'tizen': false,
            'webapis': false,
            // WebOS globals
            'webOS': false,
            // Dependency globals
            '$': false,
            'jQuery': false,
            // Jellyfin globals
            'ApiClient': true,
            'Events': true,
            'chrome': true,
            'Emby': false,
            'Hls': true,
            'LibraryMenu': true,
            'Windows': false,
            // Build time definitions
            __COMMIT_SHA__: false,
            __JF_BUILD_VERSION__: false,
            __PACKAGE_JSON_NAME__: false,
            __PACKAGE_JSON_VERSION__: false,
            __USE_SYSTEM_FONTS__: false,
            __WEBPACK_SERVE__: false
        }
    },
    settings: {
        'import/resolver': {
            node: {
                extensions: [
                    '.js',
                    '.ts',
                    '.jsx',
                    '.tsx'
                ],
                moduleDirectory: MODULE_DIRECTORIES
            }
        },
        polyfills: [
            'Promise',
            // whatwg-fetch
            'fetch',
            'Response',
            'Response.headers',
            'Response.json',
            // document-register-element
            'document.registerElement',
            // fast-text-encoding
            'TextEncoder',
            // intersection-observer
            'IntersectionObserver',
            // Core-js
            'Object.assign',
            'Object.is',
            'Object.setPrototypeOf',
            'Object.toString',
            'Object.freeze',
            'Object.seal',
            'Object.preventExtensions',
            'Object.isFrozen',
            'Object.isSealed',
            'Object.isExtensible',
            'Object.getOwnPropertyDescriptor',
            'Object.getPrototypeOf',
            'Object.keys',
            'Object.entries',
            'Object.getOwnPropertyNames',
            'Function.name',
            'Function.hasInstance',
            'Array.from',
            'Array.arrayOf',
            'Array.copyWithin',
            'Array.fill',
            'Array.find',
            'Array.findIndex',
            'Array.iterator',
            'String.fromCodePoint',
            'String.raw',
            'String.iterator',
            'String.codePointAt',
            'String.endsWith',
            'String.includes',
            'String.repeat',
            'String.startsWith',
            'String.trim',
            'String.anchor',
            'String.big',
            'String.blink',
            'String.bold',
            'String.fixed',
            'String.fontcolor',
            'String.fontsize',
            'String.italics',
            'String.link',
            'String.small',
            'String.strike',
            'String.sub',
            'String.sup',
            'URL',
            'URLSearchParams',
            'RegExp',
            'Number',
            'Math',
            'Date',
            'async',
            'Symbol',
            'Map',
            'Set',
            'WeakMap',
            'WeakSet',
            'ArrayBuffer',
            'DataView',
            'Int8Array',
            'Uint8Array',
            'Uint8ClampedArray',
            'Int16Array',
            'Uint16Array',
            'Int32Array',
            'Uint32Array',
            'Float32Array',
            'Float64Array',
            'Reflect'
        ]
    },
    rules: {
        // TODO: Add typescript recommended typed rules
        '@typescript-eslint/naming-convention': [
            'error',
            {
                selector: 'default',
                format: [ 'camelCase', 'PascalCase' ],
                leadingUnderscore: 'allow'
            },
            {
                selector: 'variable',
                format: [ 'camelCase', 'PascalCase', 'UPPER_CASE' ],
                leadingUnderscore: 'allowSingleOrDouble',
                trailingUnderscore: 'allowSingleOrDouble'
            },
            {
                selector: 'typeLike',
                format: [ 'PascalCase' ]
            },
            {
                selector: 'enumMember',
                format: [ 'PascalCase', 'UPPER_CASE' ]
            },
            {
                selector: [ 'objectLiteralProperty', 'typeProperty' ],
                format: [ 'camelCase', 'PascalCase' ],
                leadingUnderscore: 'allowSingleOrDouble',
                trailingUnderscore: 'allowSingleOrDouble'
            },
            // Ignore numbers, locale strings (en-us), aria/data attributes and CSS selectors
            {
                selector: [ 'objectLiteralProperty', 'typeProperty' ],
                format: null,
                filter: {
                    regex: '[ &\\-]|^([0-9]+)$',
                    match: true
                }
            }
        ],
        '@typescript-eslint/no-deprecated': 'warn',
        '@typescript-eslint/no-floating-promises': 'error',
        '@typescript-eslint/prefer-string-starts-ends-with': 'error'
    }
};

export default tseslint.config(
    ...sharedConfigs,

    // Config files use node globals
    {
        ignores: [ ADDON_SOURCE_PATTERN ],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    },

    // Config files are commonjs by default
    {
        files: [ '**/*.{cjs,js}' ],
        ignores: [ ADDON_SOURCE_PATTERN ],
        languageOptions: {
            sourceType: 'commonjs'
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off'
        }
    },

    // App files
    {
        files: [
            `${ADDON_SOURCE_PATTERN}/**/*.{js,jsx,ts,tsx}`
        ],
        ...addonSourceConfig
    },

    // Legacy JS (less strict)
    {
        files: [ `${ADDON_SOURCE_PATTERN}/**/*.{js,jsx}` ],
        rules: {
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-this-alias': 'off',

            'sonarjs/public-static-readonly': 'off',

            // TODO: Enable the following rules and fix issues
            'sonarjs/cognitive-complexity': 'off',
            'sonarjs/constructor-for-side-effects': 'off',
            'sonarjs/function-return-type': 'off',
            'sonarjs/no-async-constructor': 'off',
            'sonarjs/no-duplicate-string': 'off',
            'sonarjs/no-ignored-exceptions': 'off',
            'sonarjs/no-invariant-returns': 'warn',
            'sonarjs/no-nested-functions': 'off',
            'sonarjs/void-use': 'off'
        }
    }
);
