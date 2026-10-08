using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Addon;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class AddonAssetControllerTests
{
    private const string AssetRoute = "/" + AssetFunctions.RoutePrefix + "/";

    // Every file embedded by the current build; the plugin build fails without a built add-on
    public static TheoryData<string> EmbeddedAssets
    {
        get
        {
            TheoryData<string> assets = new TheoryData<string>();
            foreach (string relativePath in AddonCatalog.Resources.Keys.Order(StringComparer.Ordinal))
            {
                assets.Add(relativePath);
            }

            return assets;
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("does-not-exist.js")]
    [InlineData("libraries/webgpu-player/does-not-exist.wasm")]
    [InlineData("libraries//x.wasm")]
    [InlineData("%2E%2E/Jellyfin.Plugin.WebGPUPlayer.dll")]
    [InlineData("..%5CJellyfin.Plugin.WebGPUPlayer.dll")]
    public async Task GetAsset_UnknownOrNonRelativePath_ReturnsNotFound(string path)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri(AssetRoute + path, UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory(SkipTestWithoutData = true)]
    [MemberData(nameof(EmbeddedAssets))]
    public async Task GetAsset_EmbeddedFile_ServesItsBytesTypeAndCachePolicy(string relativePath)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = application.GetTestClient();
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, new Uri(AssetRoute + EscapePath(relativePath), UriKind.Relative));
        request.Headers.AcceptEncoding.ParseAdd("gzip, deflate, br");

        using HttpResponseMessage response = await client.SendAsync(request, cancellationToken);

        (string assetPath, string? contentEncoding, bool variesByEncoding) = AssetFunctions.SelectRepresentation(
            relativePath,
            AddonCatalog.Resources,
            StringWithQualityHeaderValue.ParseList(["gzip, deflate, br"]));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(AssetFunctions.GetContentType(relativePath), response.Content.Headers.ContentType?.MediaType);
        Assert.Equal(AssetFunctions.GetCacheControl(relativePath), string.Join(", ", response.Headers.NonValidated[HeaderNames.CacheControl]));
        Assert.Equal(contentEncoding, response.Content.Headers.ContentEncoding.SingleOrDefault());
        Assert.Equal(variesByEncoding, response.Headers.Vary.Contains(HeaderNames.AcceptEncoding));
        Assert.Equal(await ReadEmbeddedAsync(assetPath, cancellationToken), await response.Content.ReadAsByteArrayAsync(cancellationToken));
    }

    [Fact]
    public void EmbeddedAddon_IsEitherAbsentOrComplete()
    {
        // An embedded manifest must name an embedded entry; without a manifest nothing is injected
        if (AddonCatalog.Resources.ContainsKey(AssetFunctions.ManifestFileName))
        {
            Assert.NotNull(AddonCatalog.Entry);
            Assert.True(AddonCatalog.Resources.ContainsKey(AddonCatalog.Entry));
            Assert.Null(AddonCatalog.Problem);
        }
        else
        {
            Assert.Null(AddonCatalog.Entry);
            Assert.NotNull(AddonCatalog.Problem);
        }

        Assert.All(AddonCatalog.Resources.Values, resourceName => Assert.StartsWith(AssetFunctions.ResourcePrefix, resourceName, StringComparison.Ordinal));
    }

    private static async Task<WebApplication> StartServerAsync(CancellationToken cancellationToken)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddControllers().AddApplicationPart(typeof(AddonAssetController).Assembly);
        WebApplication application = builder.Build();
        application.MapControllers();
        await application.StartAsync(cancellationToken);
        return application;
    }

    private static async Task<byte[]> ReadEmbeddedAsync(string relativePath, CancellationToken cancellationToken)
    {
        await using Stream stream = AddonCatalog.OpenAsset(relativePath)!;
        using MemoryStream copy = new MemoryStream();
        await stream.CopyToAsync(copy, cancellationToken);
        return copy.ToArray();
    }

    private static string EscapePath(string relativePath)
    {
        IEnumerable<string> segments = relativePath.Split('/').Select(Uri.EscapeDataString);
        return string.Join('/', segments);
    }
}
