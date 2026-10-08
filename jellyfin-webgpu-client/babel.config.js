// Same transpilation as Jellyfin Web's babel.config.js, so bundled host modules are transpiled identically.
// The add-on closure has no JSX, so @babel/preset-react is not needed
module.exports = {
    babelrcRoots: [
        // Keep the root as a root
        '.'
    ],
    sourceType: 'unambiguous',
    presets: [
        [
            '@babel/preset-env',
            {
                useBuiltIns: 'usage',
                corejs: 3
            }
        ]
    ],
    plugins: [
    ]
};
