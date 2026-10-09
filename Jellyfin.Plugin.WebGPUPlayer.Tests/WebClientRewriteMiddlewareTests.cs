using System;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Transformations;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;
using Xunit;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

// Runs the middleware in front of a pipeline shaped like Jellyfin's /web serving: base URL map, response compression, default and static files
public sealed class WebClientRewriteMiddlewareTests : IDisposable
{
    private const string Page = "<!DOCTYPE html><html><head><title>Jellyfin</title></head><body></body></html>";
    private const string Config = "{\"plugins\":[\"htmlVideoPlayer/plugin\"]}";
    private const string Script = "console.log('stock bundle');";
    private const string Marker = "<!--rewritten-->";
    private const string AcceptAnyEncoding = "gzip, deflate, br";

    private readonly string webDirectory;
    private readonly PhysicalFileProvider fileProvider;

    public WebClientRewriteMiddlewareTests()
    {
        webDirectory = Directory.CreateTempSubdirectory("webgpu-player-web-").FullName;
        File.WriteAllText(Path.Combine(webDirectory, "index.html"), Page);
        File.WriteAllText(Path.Combine(webDirectory, "config.json"), Config);
        File.WriteAllText(Path.Combine(webDirectory, "main.js"), Script);
        fileProvider = new PhysicalFileProvider(webDirectory);
    }

    public void Dispose()
    {
        fileProvider.Dispose();
        Directory.Delete(webDirectory, recursive: true);
    }

    [Theory]
    [InlineData("", "/web/")]
    [InlineData("", "/web/index.html")]
    [InlineData("/jellyfin", "/jellyfin/web/")]
    [InlineData("/jellyfin", "/jellyfin/web/index.html")]
    public async Task Active_IndexHTML_IsRewrittenWithFreshValidators(string baseUrl, string requestPath)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(baseUrl, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await GetAsync(client, requestPath, cancellationToken);

        byte[] expected = Encoding.UTF8.GetBytes(RewriteForTest(WebClientFile.IndexHTML, Page)!);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(expected, await response.Content.ReadAsByteArrayAsync(cancellationToken));
        Assert.Empty(response.Content.Headers.ContentEncoding);
        Assert.Equal(expected.Length, response.Content.Headers.ContentLength);
        Assert.Equal(WebClientRewriteFunctions.ComputeETag(expected), response.Headers.ETag?.ToString());
        Assert.Equal(WebClientRewriteFunctions.RevalidateCacheControl, response.Headers.CacheControl?.ToString());
        Assert.Null(response.Content.Headers.LastModified);
        Assert.Empty(response.Headers.AcceptRanges);
    }

    [Fact]
    public async Task Active_ConfigJSON_IsRewrittenAndRevalidated()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await GetAsync(client, "/web/config.json", cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(RewriteForTest(WebClientFile.ConfigJSON, Config), await response.Content.ReadAsStringAsync(cancellationToken));
        Assert.Equal(WebClientRewriteFunctions.RevalidateCacheControl, response.Headers.CacheControl?.ToString());
    }

    [Fact]
    public async Task Active_MatchingIfNoneMatch_ReturnsNotModifiedWithoutBody()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();
        using HttpResponseMessage first = await GetAsync(client, "/web/index.html", cancellationToken);
        string etag = first.Headers.ETag!.ToString();

        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, new Uri("/web/index.html", UriKind.Relative));
        request.Headers.TryAddWithoutValidation(HeaderNames.IfNoneMatch, etag);
        using HttpResponseMessage response = await client.SendAsync(request, cancellationToken);

        Assert.Equal(HttpStatusCode.NotModified, response.StatusCode);
        Assert.Equal(etag, response.Headers.ETag?.ToString());
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(cancellationToken));
    }

    [Fact]
    public async Task Active_ValidatorsOfTheStockFile_StillGetTheRewrittenFile()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        string stockETag;
        DateTimeOffset stockLastModified;
        await using (WebApplication stockApplication = await StartServerAsync(string.Empty, isActive: false, cancellationToken))
        {
            using HttpClient stockClient = stockApplication.GetTestClient();
            using HttpResponseMessage stock = await GetAsync(stockClient, "/web/index.html", cancellationToken);
            stockETag = stock.Headers.ETag!.ToString();
            stockLastModified = stock.Content.Headers.LastModified!.Value;
        }

        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, new Uri("/web/index.html", UriKind.Relative));
        request.Headers.TryAddWithoutValidation(HeaderNames.IfNoneMatch, stockETag);
        request.Headers.IfModifiedSince = stockLastModified;
        using HttpResponseMessage response = await client.SendAsync(request, cancellationToken);

        // A browser that cached the stock page before the install gets the rewritten one, not a stale 304
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains(Marker, await response.Content.ReadAsStringAsync(cancellationToken), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Inactive_ServesTheStockFileUntouched()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: false, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri("/web/index.html", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Page, await response.Content.ReadAsStringAsync(cancellationToken));
        Assert.NotNull(response.Content.Headers.LastModified);
        Assert.Contains(response.Headers.AcceptRanges, unit => unit == "bytes");
    }

    [Theory]
    [InlineData("/web/main.js", HttpStatusCode.OK, Script)]
    [InlineData("/web/index.html.bak", HttpStatusCode.NotFound, "")]
    public async Task Active_OtherFiles_PassThrough(string requestPath, HttpStatusCode expectedStatus, string expectedBody)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri(requestPath, UriKind.Relative), cancellationToken);

        Assert.Equal(expectedStatus, response.StatusCode);
        Assert.Equal(expectedBody, await response.Content.ReadAsStringAsync(cancellationToken));
    }

    [Fact]
    public async Task Active_PathOutsideTheBaseUrl_IsNotRewritten()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync("/jellyfin", isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri("/web/index.html", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Active_MissingFile_PassesTheNotFoundThrough()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        File.Delete(Path.Combine(webDirectory, "config.json"));
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri("/web/config.json", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Active_HeadRequest_PassesThrough()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Head, new Uri("/web/index.html", UriKind.Relative));
        using HttpResponseMessage response = await client.SendAsync(request, cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Encoding.UTF8.GetByteCount(Page), response.Content.Headers.ContentLength);
        Assert.NotNull(response.Content.Headers.LastModified);
    }

    [Fact]
    public async Task Active_RewriteDeclines_ServesTheInnerFile()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(string.Empty, isActive: true, cancellationToken, (file, contents) => null);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri("/web/index.html", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Page, await response.Content.ReadAsStringAsync(cancellationToken));
    }

    [Fact]
    public async Task Active_EncodedInnerResponse_PassesThroughUnchanged()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        byte[] encodedBody = [0x1F, 0x8B, 0x08, 0x00, 0x01, 0x02];
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        await using WebApplication application = builder.Build();
        application.UseMiddleware<WebClientRewriteMiddleware>((Func<string>)(() => string.Empty), (Func<bool>)(() => true), (Func<WebClientFile, string, string?>)RewriteForTest);

        // An inner layer that compresses even without Accept-Encoding, which the middleware cannot edit
        application.Run(async context =>
        {
            context.Response.Headers.ContentEncoding = "gzip";
            await context.Response.Body.WriteAsync(encodedBody, context.RequestAborted);
        });
        await application.StartAsync(cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri("/web/config.json", UriKind.Relative), cancellationToken);

        Assert.Equal(encodedBody, await response.Content.ReadAsByteArrayAsync(cancellationToken));
        Assert.Equal("gzip", response.Content.Headers.ContentEncoding.Single());
    }

    private static string? RewriteForTest(WebClientFile file, string contents)
    {
        return file switch
        {
            WebClientFile.IndexHTML => contents.Replace("</head>", Marker + "</head>", StringComparison.Ordinal),
            WebClientFile.ConfigJSON => contents.Replace("]", ",\"WebGPUPlayer\"]", StringComparison.Ordinal),
            _ => contents,
        };
    }

    private static async Task<HttpResponseMessage> GetAsync(HttpClient client, string requestPath, CancellationToken cancellationToken)
    {
        // Inner response compression would encode these responses if the middleware let the header through
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, new Uri(requestPath, UriKind.Relative));
        request.Headers.AcceptEncoding.ParseAdd(AcceptAnyEncoding);
        return await client.SendAsync(request, cancellationToken);
    }

    private async Task<WebApplication> StartServerAsync(
        string baseUrl,
        bool isActive,
        CancellationToken cancellationToken,
        Func<WebClientFile, string, string?>? rewrite = null)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddResponseCompression();
        WebApplication application = builder.Build();
        application.UseMiddleware<WebClientRewriteMiddleware>(
            (Func<string>)(() => baseUrl),
            (Func<bool>)(() => isActive),
            rewrite ?? RewriteForTest);
        application.Map(baseUrl, mainApplication =>
        {
            mainApplication.UseResponseCompression();
            mainApplication.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider, RequestPath = "/web" });
            mainApplication.UseStaticFiles(new StaticFileOptions { FileProvider = fileProvider, RequestPath = "/web" });
        });
        await application.StartAsync(cancellationToken);
        return application;
    }
}
