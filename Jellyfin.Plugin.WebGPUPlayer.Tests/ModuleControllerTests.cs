using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;
using HeaderNames = Microsoft.Net.Http.Headers.HeaderNames;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ModuleControllerTests : IDisposable
{
    private const string TestScheme = "Test";
    // The request header that names the test user's role; a request without it is anonymous
    private const string RoleHeader = "X-Test-Role";
    private const string AdministratorRole = "Administrator";
    private const string UserRole = "User";
    private const string Route = "/" + ModuleController.RoutePrefix + "/";
    private const string CatalogPath = Route + "Catalog";
    private const string ListingPath = Route + "Catalog/All";
    private const string DecoderPackagesPath = Route + "DecoderPackages";
    private const string PassesPath = Route + "Passes";
    private const string BlendFileName = "blend.wgsl";
    private const string BlendSource = "//! name: Blend\nfn kernel() {}\n";
    private const string UnsafePassName = "..%2Fescape.wgsl";

    private readonly DirectoryInfo dataFolder = Directory.CreateTempSubdirectory("webgpu-player-module-routes-");

    public void Dispose()
    {
        dataFolder.Delete(recursive: true);
    }

    [Fact]
    public async Task GetCatalog_Anonymous_IsUnauthorized()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri(CatalogPath, UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetCatalog_SignedInUser_GetsTheOfferedModulesInCamelCase()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.GetAsync(new Uri(CatalogPath, UriKind.Relative), cancellationToken);
        using JsonDocument catalog = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(ModuleController.RevalidateCacheControl, string.Join(", ", response.Headers.NonValidated[HeaderNames.CacheControl]));
        JsonElement package = Assert.Single(catalog.RootElement.GetProperty("decoderPackages").EnumerateArray());
        Assert.Equal(ModuleTestFiles.HEVCId, package.GetProperty("id").GetString());
        Assert.Equal("hevc", Assert.Single(package.GetProperty("codecs").EnumerateArray()).GetString());
        Assert.StartsWith("//! id: hevc\n", package.GetProperty("header").GetString(), StringComparison.Ordinal);
        Assert.Equal(ModuleTestFiles.SharpenFileName, Assert.Single(catalog.RootElement.GetProperty("passes").EnumerateArray()).GetProperty("fileName").GetString());
    }

    [Fact]
    public async Task GetDecoderPackage_ServesItsBytesWithItsHashAsEntityTag()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        ModuleStore store = application.Services.GetRequiredService<ModuleStore>();
        (byte[] Bytes, string ContentHash) package = store.GetOfferedDecoderPackage(ModuleTestFiles.HEVCId)!.Value;

        using HttpResponseMessage response = await client.GetAsync(new Uri(DecoderPackagesPath + "/" + ModuleTestFiles.HEVCId, UriKind.Relative), cancellationToken);
        using HttpRequestMessage revalidation = new HttpRequestMessage(HttpMethod.Get, new Uri(DecoderPackagesPath + "/" + ModuleTestFiles.HEVCId, UriKind.Relative));
        revalidation.Headers.IfNoneMatch.Add(new EntityTagHeaderValue("\"" + package.ContentHash + "\""));
        using HttpResponseMessage revalidated = await client.SendAsync(revalidation, cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(DecoderPackageFunctions.ContentType, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("\"" + package.ContentHash + "\"", response.Headers.ETag?.Tag);
        Assert.Equal(package.Bytes, await response.Content.ReadAsByteArrayAsync(cancellationToken));
        Assert.Equal(HttpStatusCode.NotModified, revalidated.StatusCode);
    }

    [Fact]
    public async Task GetModuleFiles_UnknownOrDisabled_AreNotFound()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        Assert.Null(application.Services.GetRequiredService<ModuleStore>().SetPassEnabled(ModuleTestFiles.SharpenFileName, false));

        using HttpResponseMessage unknown = await client.GetAsync(new Uri(DecoderPackagesPath + "/vc1", UriKind.Relative), cancellationToken);
        using HttpResponseMessage disabled = await client.GetAsync(new Uri(PassesPath + "/" + ModuleTestFiles.SharpenFileName, UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, disabled.StatusCode);
    }

    [Fact]
    public async Task AdministrativeRoutes_SignedInUser_IsForbidden()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage listing = await client.GetAsync(new Uri(ListingPath, UriKind.Relative), cancellationToken);
        using HttpResponseMessage upload = await client.PostAsync(new Uri(DecoderPackagesPath, UriKind.Relative), CreateBody(ModuleTestFiles.CreatePackage(ModuleTestFiles.AudioHeader)), cancellationToken);
        using HttpResponseMessage disable = await client.DeleteAsync(new Uri(DecoderPackagesPath + "/" + ModuleTestFiles.HEVCId + "/Enabled", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.Forbidden, listing.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, upload.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, disable.StatusCode);
    }

    [Fact]
    public async Task Administrator_UploadsDisablesAndRemoves_AndEachAnswerIsTheListing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);

        using HttpResponseMessage upload = await client.PostAsync(
            new Uri(PassesPath + "?fileName=" + BlendFileName, UriKind.Relative),
            CreateBody(Encoding.UTF8.GetBytes(BlendSource)),
            cancellationToken);
        using JsonDocument uploaded = JsonDocument.Parse(await upload.Content.ReadAsStringAsync(cancellationToken));
        using HttpResponseMessage disable = await client.DeleteAsync(new Uri(PassesPath + "/" + BlendFileName + "/Enabled", UriKind.Relative), cancellationToken);
        using JsonDocument disabled = JsonDocument.Parse(await disable.Content.ReadAsStringAsync(cancellationToken));
        using HttpResponseMessage remove = await client.DeleteAsync(new Uri(PassesPath + "/" + BlendFileName, UriKind.Relative), cancellationToken);
        using JsonDocument removed = JsonDocument.Parse(await remove.Content.ReadAsStringAsync(cancellationToken));

        Assert.Equal(HttpStatusCode.OK, upload.StatusCode);
        Assert.Equal([ModuleTestFiles.SharpenFileName, BlendFileName], ReadKeys(uploaded, "passes"));
        Assert.Equal(HttpStatusCode.OK, disable.StatusCode);
        Assert.False(FindEntry(disabled, "passes", BlendFileName).GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, remove.StatusCode);
        Assert.Equal([ModuleTestFiles.SharpenFileName], ReadKeys(removed, "passes"));
    }

    [Fact]
    public async Task Administrator_RefusedChanges_AnswerWithTheFailedCheck()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);

        using HttpResponseMessage malformed = await client.PostAsync(new Uri(DecoderPackagesPath, UriKind.Relative), CreateBody(Encoding.UTF8.GetBytes("not a module")), cancellationToken);
        using HttpResponseMessage unsafeName = await client.PostAsync(new Uri(PassesPath + "?fileName=" + UnsafePassName, UriKind.Relative), CreateBody(Encoding.UTF8.GetBytes(BlendSource)), cancellationToken);
        using HttpResponseMessage unknown = await client.DeleteAsync(new Uri(DecoderPackagesPath + "/vc1", UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
        Assert.Equal("package-invalid", await ReadCodeAsync(malformed, cancellationToken));
        Assert.Equal(HttpStatusCode.BadRequest, unsafeName.StatusCode);
        Assert.Equal("pass-file-name", await ReadCodeAsync(unsafeName, cancellationToken));
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal(ModuleProblem.UnknownModuleCode, await ReadCodeAsync(unknown, cancellationToken));
    }

    private static HttpClient CreateClient(WebApplication application, string role)
    {
        HttpClient client = application.GetTestClient();
        client.DefaultRequestHeaders.Add(RoleHeader, role);
        return client;
    }

    private static ByteArrayContent CreateBody(byte[] bytes)
    {
        ByteArrayContent content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        return content;
    }

    private static List<string?> ReadKeys(JsonDocument listing, string kind)
    {
        List<string?> keys = [];
        foreach (JsonElement entry in listing.RootElement.GetProperty(kind).EnumerateArray())
        {
            keys.Add(entry.GetProperty("key").GetString());
        }

        return keys;
    }

    private static JsonElement FindEntry(JsonDocument listing, string kind, string key)
    {
        foreach (JsonElement entry in listing.RootElement.GetProperty(kind).EnumerateArray())
        {
            if (entry.GetProperty("key").GetString() == key)
            {
                return entry.Clone();
            }
        }

        throw new KeyNotFoundException(key);
    }

    private static async Task<string?> ReadCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        using JsonDocument problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return problem.RootElement.GetProperty("code").GetString();
    }

    private async Task<WebApplication> StartServerAsync(CancellationToken cancellationToken)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Logging.ClearProviders();
        builder.Services.AddSingleton(new ModuleStore(
            dataFolder.FullName,
            ModuleTestFiles.DecoderSection,
            [("hevc.wasm", ModuleTestFiles.CreatePackage(ModuleTestFiles.VideoHeader))],
            [(ModuleTestFiles.SharpenFileName, Encoding.UTF8.GetBytes(ModuleTestFiles.SharpenSource))],
            NullLogger<ModuleStore>.Instance));
        // The server's own policies elevate administrators; the test scheme stands in for its authentication
        builder.Services.AddAuthentication(TestScheme).AddScheme<AuthenticationSchemeOptions, RoleHeaderAuthenticationHandler>(TestScheme, null);
        builder.Services.AddAuthorization(options => options.AddPolicy(Policies.RequiresElevation, policy => policy.RequireRole(AdministratorRole)));
        builder.Services.AddControllers().AddApplicationPart(typeof(ModuleController).Assembly);
        WebApplication application = builder.Build();
        application.UseAuthentication();
        application.UseAuthorization();
        application.MapControllers();
        await application.StartAsync(cancellationToken);
        return application;
    }

    // Signs a request in with the role its header names
    private sealed class RoleHeaderAuthenticationHandler(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
        {
            string? role = Request.Headers[RoleHeader];
            if (string.IsNullOrEmpty(role))
            {
                return Task.FromResult(AuthenticateResult.NoResult());
            }

            ClaimsIdentity identity = new ClaimsIdentity([new Claim(ClaimTypes.Name, role), new Claim(ClaimTypes.Role, role)], TestScheme);
            return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), TestScheme)));
        }
    }
}
