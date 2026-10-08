using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class AssetFunctionsTests
{
    private const string Entry = "plugin.0123abcd.js";
    private const string Wasm = "libraries/webgpu-player/x.wasm";

    [Theory]
    [InlineData(Entry, Entry)]
    [InlineData(Wasm, Wasm)]
    [InlineData("libraries\\webgpu-player\\x.wasm", Wasm)]
    [InlineData("libraries/hls.js-fork/a..b.js", "libraries/hls.js-fork/a..b.js")]
    [InlineData(".hidden/.x", ".hidden/.x")]
    public void TryNormalizePath_AcceptsRelativePathsWithEitherSeparator(string path, string expected)
    {
        Assert.True(AssetFunctions.TryNormalizePath(path, out string normalizedPath));
        Assert.Equal(expected, normalizedPath);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("/plugin.js")]
    [InlineData("\\plugin.js")]
    [InlineData("..")]
    [InlineData("../Jellyfin.Plugin.WebGPUPlayer.dll")]
    [InlineData("libraries/../../system.xml")]
    [InlineData("libraries\\..\\..\\system.xml")]
    [InlineData("libraries/..\\..\\system.xml")]
    [InlineData("./plugin.js")]
    [InlineData("libraries/./x.wasm")]
    [InlineData("libraries//x.wasm")]
    [InlineData("libraries/")]
    public void TryNormalizePath_RejectsTraversalAndNonRelativePaths(string? path)
    {
        Assert.False(AssetFunctions.TryNormalizePath(path, out string normalizedPath));
        Assert.Empty(normalizedPath);
    }

    [Fact]
    public void BuildResourceLookup_KeepsOnlyAddonResourcesAndNormalizesSeparators()
    {
        string[] resourceNames =
        [
            "Jellyfin.Plugin.WebGPUPlayer.Unrelated.resource.html",
            "WebGPUPlayer.Assets/addon-manifest.json",
            "WebGPUPlayer.Assets/" + Entry,
            "WebGPUPlayer.Assets/libraries\\webgpu-player\\x.wasm",
            "WebGPUPlayer.Assets/../escape.js",
            "WebGPUPlayer.Assets/",
        ];

        FrozenDictionary<string, string> lookup = AssetFunctions.BuildResourceLookup(resourceNames);

        Assert.Equal(3, lookup.Count);
        Assert.Equal("WebGPUPlayer.Assets/addon-manifest.json", lookup[AssetFunctions.ManifestFileName]);
        Assert.Equal("WebGPUPlayer.Assets/" + Entry, lookup[Entry]);
        Assert.Equal("WebGPUPlayer.Assets/libraries\\webgpu-player\\x.wasm", lookup[Wasm]);
        Assert.False(lookup.ContainsKey("PLUGIN.0123ABCD.JS"));
    }

    [Theory]
    [InlineData(Entry, "text/javascript")]
    [InlineData("chunks/feature.mjs", "text/javascript")]
    [InlineData(Wasm, "application/wasm")]
    [InlineData("styles.0123abcd.css", "text/css")]
    [InlineData(AssetFunctions.ManifestFileName, "application/json")]
    [InlineData(Entry + ".map", "application/json")]
    [InlineData("libraries/webgpu-player/vector.bin", "application/octet-stream")]
    [InlineData("libraries/webgpu-player/LICENSE", "application/octet-stream")]
    [InlineData("libraries/webgpu-player/table.unknownext", "application/octet-stream")]
    public void GetContentType_MapsKnownExtensionsAndFallsBackToOctetStream(string path, string expected)
    {
        Assert.Equal(expected, AssetFunctions.GetContentType(path));
    }

    [Theory]
    [InlineData(AssetFunctions.ManifestFileName, "no-cache")]
    [InlineData(Entry, "public, max-age=31536000, immutable")]
    [InlineData(Wasm, "public, max-age=31536000, immutable")]
    [InlineData("libraries/" + AssetFunctions.ManifestFileName, "public, max-age=31536000, immutable")]
    public void GetCacheControl_RevalidatesOnlyTheRootManifest(string path, string expected)
    {
        Assert.Equal(expected, AssetFunctions.GetCacheControl(path));
    }

    [Theory]
    [InlineData("gzip, deflate, br, zstd", Wasm + ".br", "br")]
    [InlineData("gzip", Wasm + ".gz", "gzip")]
    [InlineData("br;q=0, gzip", Wasm + ".gz", "gzip")]
    [InlineData("gzip;q=1, br;q=0.5", Wasm + ".gz", "gzip")]
    [InlineData("*", Wasm + ".br", "br")]
    [InlineData("*;q=0.5, gzip;q=0", Wasm + ".br", "br")]
    [InlineData("*;q=0", Wasm, null)]
    [InlineData("identity", Wasm, null)]
    [InlineData("", Wasm, null)]
    public void SelectRepresentation_WithPrecompressedSiblings_HonorsAcceptEncoding(string acceptEncoding, string expectedPath, string? expectedEncoding)
    {
        Dictionary<string, string> lookup = Lookup(Wasm, Wasm + ".br", Wasm + ".gz");

        (string assetPath, string? contentEncoding, bool variesByEncoding) = AssetFunctions.SelectRepresentation(Wasm, lookup, ParseAcceptEncoding(acceptEncoding));

        Assert.Equal(expectedPath, assetPath);
        Assert.Equal(expectedEncoding, contentEncoding);
        Assert.True(variesByEncoding);
    }

    [Fact]
    public void SelectRepresentation_OnlyGzipSibling_IgnoresBrotliPreference()
    {
        Dictionary<string, string> lookup = Lookup(Wasm, Wasm + ".gz");

        Assert.Equal((Wasm, (string?)null, true), AssetFunctions.SelectRepresentation(Wasm, lookup, ParseAcceptEncoding("br")));
        Assert.Equal((Wasm + ".gz", (string?)"gzip", true), AssetFunctions.SelectRepresentation(Wasm, lookup, ParseAcceptEncoding("br, gzip")));
    }

    [Fact]
    public void SelectRepresentation_WithoutSiblings_ServesTheFileWithoutVary()
    {
        Dictionary<string, string> lookup = Lookup(Wasm);

        Assert.Equal((Wasm, (string?)null, false), AssetFunctions.SelectRepresentation(Wasm, lookup, ParseAcceptEncoding("br, gzip")));
    }

    [Fact]
    public void ParseAddonManifest_ValidManifest_ReturnsNormalizedEntry()
    {
        (string? entry, string? problem) = AssetFunctions.ParseAddonManifest(
            "{\"entry\":\"" + Entry + "\",\"assetKey\":\"0123abcd\"}",
            Lookup(AssetFunctions.ManifestFileName, Entry));

        Assert.Equal(Entry, entry);
        Assert.Null(problem);
    }

    [Theory]
    [InlineData(null, "is not embedded")]
    [InlineData("{", "is not valid JSON")]
    [InlineData("{\"entry\":\"a.js\",\"entry\":\"b.js\"}", "is not valid JSON")]
    [InlineData("[]", "has no string entry")]
    [InlineData("{}", "has no string entry")]
    [InlineData("{\"entry\":42}", "has no string entry")]
    [InlineData("{\"entry\":null}", "has no string entry")]
    [InlineData("{\"entry\":\"../plugin.js\"}", "is not a relative asset path")]
    [InlineData("{\"entry\":\"/plugin.js\"}", "is not a relative asset path")]
    [InlineData("{\"entry\":\"plugin.missing.js\"}", "is not embedded")]
    public void ParseAddonManifest_UnusableManifest_ReportsTheProblem(string? manifestText, string expectedProblem)
    {
        (string? entry, string? problem) = AssetFunctions.ParseAddonManifest(manifestText, Lookup(AssetFunctions.ManifestFileName, Entry));

        Assert.Null(entry);
        Assert.NotNull(problem);
        Assert.Contains(expectedProblem, problem, StringComparison.Ordinal);
    }

    private static Dictionary<string, string> Lookup(params string[] relativePaths)
    {
        Dictionary<string, string> lookup = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string relativePath in relativePaths)
        {
            lookup.Add(relativePath, AssetFunctions.ResourcePrefix + relativePath);
        }

        return lookup;
    }

    private static IList<StringWithQualityHeaderValue> ParseAcceptEncoding(string header)
    {
        return StringWithQualityHeaderValue.ParseList([header]);
    }
}
