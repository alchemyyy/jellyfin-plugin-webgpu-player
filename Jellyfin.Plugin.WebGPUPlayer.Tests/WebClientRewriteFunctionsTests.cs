using System.Text;
using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using Microsoft.Extensions.Primitives;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class WebClientRewriteFunctionsTests
{
    private const string Page = "<html><head><title>x</title></head><body></body></html>";

    [Theory]
    [InlineData("", "/web/", WebClientFile.IndexHTML)]
    [InlineData("", "/web/index.html", WebClientFile.IndexHTML)]
    [InlineData("", "/WEB/Index.HTML", WebClientFile.IndexHTML)]
    [InlineData("", "/web/config.json", WebClientFile.ConfigJSON)]
    [InlineData("/jellyfin", "/jellyfin/web/", WebClientFile.IndexHTML)]
    [InlineData("/jellyfin", "/jellyfin/web/index.html", WebClientFile.IndexHTML)]
    [InlineData("/jellyfin", "/Jellyfin/web/config.json", WebClientFile.ConfigJSON)]
    public void GetTargetFile_WebClientFiles_AreRecognized(string baseUrl, string requestPath, WebClientFile expected)
    {
        Assert.Equal(expected, WebClientRewriteFunctions.GetTargetFile(baseUrl, requestPath));
    }

    [Theory]
    [InlineData("", null)]
    [InlineData("", "")]
    [InlineData("", "/web")]
    [InlineData("", "/web/main.jellyfin.bundle.js")]
    [InlineData("", "/web/index.htm")]
    [InlineData("", "/web/index.html.bak")]
    [InlineData("", "/web/libraries/config.json")]
    [InlineData("", "/WebGPUPlayer/assets/index.html")]
    [InlineData("", "/plugin/web/index.html")]
    [InlineData("/jellyfin", "/web/index.html")]
    [InlineData("/jellyfin", "/jellyfinx/web/index.html")]
    [InlineData("/jellyfin", "/other/jellyfin/web/index.html")]
    public void GetTargetFile_OtherPaths_AreIgnored(string baseUrl, string? requestPath)
    {
        Assert.Null(WebClientRewriteFunctions.GetTargetFile(baseUrl, requestPath));
    }

    [Theory]
    [InlineData(WebClientRewriteMode.Middleware, true, false, true)]
    [InlineData(WebClientRewriteMode.Middleware, true, true, true)]
    [InlineData(WebClientRewriteMode.FileTransformation, true, true, false)]
    [InlineData(WebClientRewriteMode.FileTransformation, true, false, false)]
    [InlineData(WebClientRewriteMode.Disabled, false, false, false)]
    [InlineData(WebClientRewriteMode.Undecided, true, false, true)]
    [InlineData(WebClientRewriteMode.Undecided, true, true, false)]
    [InlineData(WebClientRewriteMode.Undecided, false, false, false)]
    public void IsMiddlewareActive_FollowsTheRegistrarDecision(WebClientRewriteMode mode, bool addonEmbedded, bool fileTransformationLoaded, bool expected)
    {
        Assert.Equal(expected, WebClientRewriteFunctions.IsMiddlewareActive(mode, addonEmbedded, fileTransformationLoaded));
    }

    [Fact]
    public void Rewrite_WithoutPluginInstance_ReturnsTheTextUnchanged()
    {
        // Both paths run the same callbacks, which inject nothing without a plugin instance
        Assert.Equal(Page, WebClientRewriteFunctions.Rewrite(WebClientFile.IndexHTML, Page));
        Assert.Equal("{\"plugins\":[]}", WebClientRewriteFunctions.Rewrite(WebClientFile.ConfigJSON, "{\"plugins\":[]}"));
    }

    [Fact]
    public void DecodeUTF8_SkipsTheByteOrderMark()
    {
        byte[] content = [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(Page)];

        Assert.Equal(Page, WebClientRewriteFunctions.DecodeUTF8(content));
    }

    [Fact]
    public void DecodeUTF8_InvalidBytes_ReturnsNull()
    {
        Assert.Null(WebClientRewriteFunctions.DecodeUTF8([0x3C, 0xFF, 0xFE, 0x3E]));
    }

    [Fact]
    public void EncodeUTF8_WritesNoByteOrderMark()
    {
        Assert.Equal(Encoding.UTF8.GetBytes(Page), WebClientRewriteFunctions.EncodeUTF8(Page));
    }

    [Fact]
    public void ComputeETag_IsQuotedStableAndContentSpecific()
    {
        string etag = WebClientRewriteFunctions.ComputeETag(Encoding.UTF8.GetBytes(Page));

        Assert.Matches("^\"[0-9a-f]{16}\"$", etag);
        Assert.Equal(etag, WebClientRewriteFunctions.ComputeETag(Encoding.UTF8.GetBytes(Page)));
        Assert.NotEqual(etag, WebClientRewriteFunctions.ComputeETag(Encoding.UTF8.GetBytes(Page + " ")));
    }

    [Theory]
    [InlineData("\"0123456789abcdef\"", true)]
    [InlineData("W/\"0123456789abcdef\"", true)]
    [InlineData("\"other\", \"0123456789abcdef\"", true)]
    [InlineData("*", true)]
    [InlineData("\"other\"", false)]
    [InlineData("", false)]
    [InlineData("not a tag", false)]
    public void MatchesIfNoneMatch_UsesWeakComparison(string ifNoneMatch, bool expected)
    {
        Assert.Equal(expected, WebClientRewriteFunctions.MatchesIfNoneMatch(new StringValues(ifNoneMatch), "\"0123456789abcdef\""));
    }
}
