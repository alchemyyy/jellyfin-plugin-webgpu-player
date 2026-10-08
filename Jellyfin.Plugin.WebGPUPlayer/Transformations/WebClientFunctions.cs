using System;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Unicode;
using Jellyfin.Plugin.WebGPUPlayer.Addon;

namespace Jellyfin.Plugin.WebGPUPlayer.Transformations;

/// <summary>
/// Stateless rewrites of the Jellyfin Web files that load the client add-on.
/// </summary>
public static class WebClientFunctions
{
    /// <summary>
    /// The plugin name added to <c>config.json</c>. Jellyfin Web resolves it to the window factory of the same name.
    /// </summary>
    public const string ClientPluginName = "WebGPUPlayer";

    /// <summary>
    /// The window property that carries the add-on configuration.
    /// </summary>
    public const string ClientConfigName = "WebGPUPlayerConfig";

    /// <summary>
    /// The attribute that marks the injected bootstrap script.
    /// </summary>
    public const string BootstrapMarker = "data-webgpu-player-bootstrap";

    /// <summary>
    /// How long the window factory waits for the add-on import. A factory that never settles blocks the first render.
    /// </summary>
    public const int AddonLoadTimeoutMilliseconds = 20000;

    private const string HeadCloseTag = "</head>";
    private const string PluginsProperty = "plugins";
    private const string AssetPath = "/" + AssetFunctions.RoutePrefix + "/";

    // NOTE: Classic inline script, ES2017 plus dynamic import(); the settings object literal is appended as the IIFE argument
    private const string BootstrapScriptStart = $$"""
        <script {{BootstrapMarker}}>
        (function (settings) {
            'use strict';
            const pathname = window.location.pathname;
            const webIndex = pathname.lastIndexOf('/web/');
            const base = webIndex === -1 ? '' : pathname.substring(0, webIndex);
            const assetBaseURL = base + settings.assetPath;
            window.{{ClientConfigName}} = {
                assetBaseURL: assetBaseURL
            };
            window.{{ClientPluginName}} = function () {
                let timer;
                const timeout = new Promise(function (resolve, reject) {
                    timer = setTimeout(function () {
                        reject(new Error('WebGPU Player add-on did not load within ' + settings.loadTimeout + ' ms'));
                    }, settings.loadTimeout);
                });
                const load = import(assetBaseURL + settings.entry).then(function (module) {
                    clearTimeout(timer);
                    return module.default;
                }, function (error) {
                    clearTimeout(timer);
                    throw error;
                });
                return Promise.race([load, timeout]);
            };
        })(
        """;

    private const string BootstrapScriptEnd = ");</script>";

    private static readonly JsonSerializerOptions ScriptSerializerOptions = new JsonSerializerOptions
    {
        // The default encoder escapes <, >, &, quotes, + and U+2028/U+2029, so no value can end the inline script early
        Encoder = JavaScriptEncoder.Default,
    };

    private static readonly JsonSerializerOptions ConfigSerializerOptions = new JsonSerializerOptions
    {
        // config.json is served as JSON and never inlined into HTML, so non-ASCII text stays literal
        Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
        NewLine = "\n",
        WriteIndented = true,
    };

    private static readonly JsonDocumentOptions StrictDocumentOptions = new JsonDocumentOptions { AllowDuplicateProperties = false };

    /// <summary>
    /// Inserts the bootstrap script immediately before the first <c>&lt;/head&gt;</c>, matched case-insensitively.
    /// </summary>
    /// <param name="html">The served <c>index.html</c>.</param>
    /// <param name="entry">The add-on entry module path, or <c>null</c> when no add-on is embedded.</param>
    /// <returns>The rewritten page, or <paramref name="html"/> unchanged when there is no add-on, no head end tag, or a bootstrap already.</returns>
    public static string InjectBootstrapScript(string html, string? entry)
    {
        if (string.IsNullOrEmpty(entry))
        {
            return html;
        }

        if (html.Contains(BootstrapMarker, StringComparison.OrdinalIgnoreCase))
        {
            return html;
        }

        int headCloseIndex = html.IndexOf(HeadCloseTag, StringComparison.OrdinalIgnoreCase);
        if (headCloseIndex < 0)
        {
            return html;
        }

        return html.Insert(headCloseIndex, BuildBootstrapScript(entry));
    }

    /// <summary>
    /// Builds the inline script that publishes the add-on asset URL and defines the window factory that imports the entry module.
    /// </summary>
    /// <param name="entry">The add-on entry module path below the asset route.</param>
    /// <returns>The complete script element.</returns>
    public static string BuildBootstrapScript(string entry)
    {
        JsonObject settings = new JsonObject
        {
            ["entry"] = entry,
            ["assetPath"] = AssetPath,
            ["loadTimeout"] = AddonLoadTimeoutMilliseconds,
        };

        return BootstrapScriptStart + settings.ToJsonString(ScriptSerializerOptions) + BootstrapScriptEnd;
    }

    /// <summary>
    /// Appends <see cref="ClientPluginName"/> to the <c>plugins</c> array of <c>config.json</c>.
    /// </summary>
    /// <param name="configJSON">The served <c>config.json</c>.</param>
    /// <returns>The rewritten JSON, or <paramref name="configJSON"/> unchanged when it is malformed, has no <c>plugins</c> array, or already lists the plugin.</returns>
    public static string AddPluginToConfig(string configJSON)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(configJSON, documentOptions: StrictDocumentOptions);
        }
        catch (JsonException)
        {
            // Serve malformed JSON as is; Jellyfin Web reports it and uses its defaults
            return configJSON;
        }

        // NOTE: Never create the array, because a missing key is what makes Jellyfin Web use its built-in plugin list
        if (root is not JsonObject rootObject
            || !rootObject.TryGetPropertyValue(PluginsProperty, out JsonNode? pluginsNode)
            || pluginsNode is not JsonArray plugins)
        {
            return configJSON;
        }

        foreach (JsonNode? plugin in plugins)
        {
            if (plugin is JsonValue pluginValue
                && pluginValue.TryGetValue(out string? pluginName)
                && string.Equals(pluginName, ClientPluginName, StringComparison.Ordinal))
            {
                return configJSON;
            }
        }

        plugins.Add(JsonValue.Create(ClientPluginName));
        return rootObject.ToJsonString(ConfigSerializerOptions);
    }
}
