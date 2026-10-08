using System;
using System.Linq;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class WebClientFunctionsTests
{
    private const string Entry = "plugin.0123abcd.js";
    private const string HeadCloseTag = "</head>";
    private const char LineSeparator = (char)0x2028;
    private const char LatinSmallEWithAcute = (char)0xE9;
    private const string Page = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><script defer=\"defer\" src=\"main.jellyfin.bundle.js\"></script></head><body><div id=\"reactRoot\"></div></body></html>";
    private const string Config = """
        {
          "multiserver": false,
          "themes": [{ "name": "Dark", "id": "dark", "default": true }],
          "menuLinks": [],
          "ratio": 1.50,
          "plugins": ["htmlVideoPlayer/plugin", "syncPlay/plugin"]
        }
        """;

    [Fact]
    public void InjectBootstrapScript_InsertsOneScriptImmediatelyBeforeHeadEnd()
    {
        string result = WebClientFunctions.InjectBootstrapScript(Page, Entry);

        string script = WebClientFunctions.BuildBootstrapScript(Entry);
        Assert.Equal(Page.Insert(Page.IndexOf(HeadCloseTag, StringComparison.Ordinal), script), result);
        Assert.Equal(1, CountOccurrences(result, WebClientFunctions.BootstrapMarker));
        Assert.StartsWith("<script " + WebClientFunctions.BootstrapMarker + ">", script, StringComparison.Ordinal);
        Assert.EndsWith("</script></head><body><div id=\"reactRoot\"></div></body></html>", result, StringComparison.Ordinal);
    }

    [Fact]
    public void InjectBootstrapScript_MatchesHeadEndCaseInsensitivelyAndUsesTheFirst()
    {
        const string UpperCasePage = "<HTML><HEAD><TITLE>x</TITLE></HEAD><BODY><template></head></template></BODY></HTML>";

        string result = WebClientFunctions.InjectBootstrapScript(UpperCasePage, Entry);

        Assert.Equal(UpperCasePage.IndexOf("</HEAD>", StringComparison.Ordinal), result.IndexOf("<script ", StringComparison.Ordinal));
        Assert.EndsWith("</script></HEAD><BODY><template></head></template></BODY></HTML>", result, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(result, WebClientFunctions.BootstrapMarker));
    }

    [Fact]
    public void InjectBootstrapScript_AlreadyInjected_ReturnsInputUnchanged()
    {
        string once = WebClientFunctions.InjectBootstrapScript(Page, Entry);

        string twice = WebClientFunctions.InjectBootstrapScript(once, "plugin.other.js");

        Assert.Same(once, twice);
    }

    [Fact]
    public void InjectBootstrapScript_WithoutHeadEnd_ReturnsInputUnchanged()
    {
        const string HeadlessPage = "<html><body>no head end tag</body></html>";

        Assert.Same(HeadlessPage, WebClientFunctions.InjectBootstrapScript(HeadlessPage, Entry));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void InjectBootstrapScript_WithoutAddon_ReturnsInputUnchanged(string? entry)
    {
        Assert.Same(Page, WebClientFunctions.InjectBootstrapScript(Page, entry));
    }

    [Fact]
    public void BuildBootstrapScript_CarriesOnlyLoadSettingsAndContractNames()
    {
        string script = WebClientFunctions.BuildBootstrapScript(Entry);

        // The player's preferences live in each browser, so the bootstrap carries only what loading the add-on needs
        JsonObject settings = ReadSettings(script);
        Assert.Equal(3, settings.Count);
        Assert.Equal(Entry, (string?)settings["entry"]);
        Assert.Equal("/" + AssetFunctions.RoutePrefix + "/", (string?)settings["assetPath"]);
        Assert.Equal(WebClientFunctions.AddonLoadTimeoutMilliseconds, (int?)settings["loadTimeout"]);
        Assert.Contains("pathname.lastIndexOf('/web/')", script, StringComparison.Ordinal);
        Assert.Contains("window.WebGPUPlayerConfig = {", script, StringComparison.Ordinal);
        Assert.Contains("window.WebGPUPlayer = function () {", script, StringComparison.Ordinal);
        Assert.Contains("import(assetBaseURL + settings.entry)", script, StringComparison.Ordinal);
        Assert.Contains("return Promise.race([load, timeout]);", script, StringComparison.Ordinal);
    }

    [Fact]
    public void BuildBootstrapScript_EscapesValuesSoTheInlineScriptCannotEndEarly()
    {
        string hostileEntry = "x</script><script>alert(1)</script><!--'\"&" + LineSeparator + LatinSmallEWithAcute + ".js";

        string script = WebClientFunctions.BuildBootstrapScript(hostileEntry);

        string body = script[(script.IndexOf('>', StringComparison.Ordinal) + 1)..script.LastIndexOf("</script>", StringComparison.Ordinal)];
        Assert.False(body.Contains('<', StringComparison.Ordinal));
        Assert.False(body.Contains(LineSeparator, StringComparison.Ordinal));
        Assert.Equal(hostileEntry, (string?)ReadSettings(script)["entry"]);
    }

    [Fact]
    public void AddPluginToConfig_AppendsToExistingPluginsAndPreservesTheRest()
    {
        string result = WebClientFunctions.AddPluginToConfig(Config);

        JsonNode? expected = JsonNode.Parse(Config);
        expected!["plugins"]!.AsArray().Add(JsonValue.Create(WebClientFunctions.ClientPluginName));
        Assert.True(JsonNode.DeepEquals(expected, JsonNode.Parse(result)));
        Assert.Equal(
            ["htmlVideoPlayer/plugin", "syncPlay/plugin", WebClientFunctions.ClientPluginName],
            JsonNode.Parse(result)!["plugins"]!.AsArray().Select(plugin => (string?)plugin));
        Assert.Contains("\"ratio\": 1.50", result, StringComparison.Ordinal);
        Assert.False(result.Contains('\r', StringComparison.Ordinal));
    }

    [Fact]
    public void AddPluginToConfig_KeepsNonASCIITextLiteral()
    {
        string serverName = "Caf" + LatinSmallEWithAcute;
        string config = "{\"servers\":[\"" + serverName + "\"],\"plugins\":[]}";

        string result = WebClientFunctions.AddPluginToConfig(config);

        Assert.Contains("\"" + serverName + "\"", result, StringComparison.Ordinal);
        Assert.Equal(WebClientFunctions.ClientPluginName, (string?)JsonNode.Parse(result)!["plugins"]![0]);
    }

    [Fact]
    public void AddPluginToConfig_AlreadyListed_ReturnsInputUnchanged()
    {
        const string ListedConfig = "{\"plugins\":[\"htmlVideoPlayer/plugin\",\"WebGPUPlayer\"]}";

        Assert.Same(ListedConfig, WebClientFunctions.AddPluginToConfig(ListedConfig));
    }

    [Theory]
    [InlineData("{}")]
    [InlineData("{\"multiserver\":false,\"themes\":[]}")]
    [InlineData("[\"htmlVideoPlayer/plugin\"]")]
    [InlineData("null")]
    public void AddPluginToConfig_MissingPlugins_ReturnsInputUnchanged(string config)
    {
        Assert.Same(config, WebClientFunctions.AddPluginToConfig(config));
    }

    [Theory]
    [InlineData("{\"plugins\":\"htmlVideoPlayer/plugin\"}")]
    [InlineData("{\"plugins\":{\"0\":\"htmlVideoPlayer/plugin\"}}")]
    [InlineData("{\"plugins\":null}")]
    [InlineData("{\"plugins\":42}")]
    public void AddPluginToConfig_NonArrayPlugins_ReturnsInputUnchanged(string config)
    {
        Assert.Same(config, WebClientFunctions.AddPluginToConfig(config));
    }

    [Theory]
    [InlineData("")]
    [InlineData("{\"plugins\":[")]
    [InlineData("{\"plugins\":[]} trailing")]
    [InlineData("{\"plugins\":[],}")]
    [InlineData("{\"plugins\":[] /* comment */}")]
    [InlineData("{\"plugins\":[],\"plugins\":[]}")]
    public void AddPluginToConfig_MalformedJSON_ReturnsInputUnchanged(string config)
    {
        Assert.Same(config, WebClientFunctions.AddPluginToConfig(config));
    }

    private static JsonObject ReadSettings(string script)
    {
        const string ArgumentStart = "})(";
        const string ArgumentEnd = ");</script>";
        int start = script.IndexOf(ArgumentStart, StringComparison.Ordinal) + ArgumentStart.Length;
        int end = script.LastIndexOf(ArgumentEnd, StringComparison.Ordinal);
        return JsonNode.Parse(script[start..end])!.AsObject();
    }

    private static int CountOccurrences(string text, string value)
    {
        int count = 0;
        int index = text.IndexOf(value, StringComparison.Ordinal);
        while (index >= 0)
        {
            count++;
            index = text.IndexOf(value, index + value.Length, StringComparison.Ordinal);
        }

        return count;
    }
}
