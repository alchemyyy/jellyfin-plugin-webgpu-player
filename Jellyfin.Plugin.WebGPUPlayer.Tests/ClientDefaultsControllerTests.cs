using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.WebGPUPlayer.ClientDefaults;
using Jellyfin.Plugin.WebGPUPlayer.Modules;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static Jellyfin.Plugin.WebGPUPlayer.Tests.RoleHeaderTestServer;
using HeaderNames = Microsoft.Net.Http.Headers.HeaderNames;

namespace Jellyfin.Plugin.WebGPUPlayer.Tests;

public sealed class ClientDefaultsControllerTests : IDisposable
{
    private const string ClientDefaultsPath = "/" + ModuleController.RoutePrefix + "/ClientDefaults";
    private const string JsonContentType = "application/json";
    private const string Defaults = """
        {
            "settings": {
                "preferredVideoPlayer": "webgpu",
                "brightness": 1.25,
                "hdrOutput": false,
                "presentationFiles": [{ "fileName": "sharpen.wgsl", "parameters": { "strength": 0.5 } }]
            }
        }
        """;

    private readonly DirectoryInfo dataFolder = Directory.CreateTempSubdirectory("webgpu-player-client-defaults-routes-");

    public static TheoryData<string> MalformedDocuments => new TheoryData<string>
    {
        "not json",
        """{ "settings": { "brightness": 1, } }""",
        """{ "settings": { "brightness": 1 /* comment */ } }""",
        """{ "settings": { "brightness": 1, "brightness": 2 } }""",
        """{ "settings": { "brightness": 1, "\u0062rightness": 2 } }""",
        // The root and the settings are two levels, so the value's 15 levels pass the limit of 16
        """{ "settings": { "nested": """ + new string('[', 15) + new string(']', 15) + " } }",
        """[]""",
        """{ "defaults": {} }""",
        """{ "settings": [] }""",
        """{ "settings": { "1brightness": 1 } }""",
        """{ "settings": { "tone-map": "aces" } }""",
        """{ "settings": { """ + "\"" + new string('a', ClientDefaultsFunctions.MaximumKeyLength + 1) + "\": 1 } }",
        """{ "settings": { "brightness": null } }""",
        """{ "settings": { """ + string.Join(", ", Enumerable.Range(0, ClientDefaultsFunctions.MaximumSettingCount + 1).Select(index => "\"key" + index + "\": 1")) + " } }"
    };

    public void Dispose()
    {
        dataFolder.Delete(recursive: true);
    }

    [Fact]
    public async Task GetClientDefaults_Anonymous_IsUnauthorized()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = application.GetTestClient();

        using HttpResponseMessage response = await client.GetAsync(new Uri(ClientDefaultsPath, UriKind.Relative), cancellationToken);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetClientDefaults_SignedInUser_GetsTheStoredSettingsVerbatim()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);
        Assert.Null(application.Services.GetRequiredService<ClientDefaultsStore>().SetDocument(Encoding.UTF8.GetBytes(Defaults)).Problem);

        using HttpResponseMessage response = await client.GetAsync(new Uri(ClientDefaultsPath, UriKind.Relative), cancellationToken);
        using JsonDocument answer = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        using JsonDocument expected = JsonDocument.Parse(Defaults);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(ModuleController.RevalidateCacheControl, string.Join(", ", response.Headers.NonValidated[HeaderNames.CacheControl]));
        Assert.True(JsonElement.DeepEquals(expected.RootElement, answer.RootElement), answer.RootElement.GetRawText());
    }

    [Fact]
    public async Task GetClientDefaults_NoneSet_AnswersEmptySettings()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.GetAsync(new Uri(ClientDefaultsPath, UriKind.Relative), cancellationToken);
        using JsonDocument answer = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(answer.RootElement.GetProperty("settings").EnumerateObject());
    }

    [Fact]
    public async Task SetClientDefaults_SignedInUser_IsForbidden()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, UserRole);

        using HttpResponseMessage response = await client.PutAsync(new Uri(ClientDefaultsPath, UriKind.Relative), CreateBody(Defaults), cancellationToken);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Empty(application.Services.GetRequiredService<ClientDefaultsStore>().GetSettings());
    }

    [Fact]
    public async Task SetClientDefaults_Administrator_AnswersAndKeepsThemForTheNextStart()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);

        using HttpResponseMessage response = await client.PutAsync(new Uri(ClientDefaultsPath, UriKind.Relative), CreateBody(Defaults), cancellationToken);
        using JsonDocument answer = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        using JsonDocument expected = JsonDocument.Parse(Defaults);
        IReadOnlyDictionary<string, JsonElement> reopened = new ClientDefaultsStore(dataFolder.FullName, NullLogger<ClientDefaultsStore>.Instance).GetSettings();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(JsonElement.DeepEquals(expected.RootElement, answer.RootElement), answer.RootElement.GetRawText());
        Assert.Equal(["preferredVideoPlayer", "brightness", "hdrOutput", "presentationFiles"], reopened.Keys);
        foreach (JsonProperty setting in expected.RootElement.GetProperty("settings").EnumerateObject())
        {
            Assert.True(JsonElement.DeepEquals(setting.Value, reopened[setting.Name]), setting.Name);
        }
    }

    [Theory]
    [MemberData(nameof(MalformedDocuments))]
    public async Task SetClientDefaults_MalformedDocument_IsRefusedAndKeepsTheDefaults(string document)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);
        ClientDefaultsStore store = application.Services.GetRequiredService<ClientDefaultsStore>();
        Assert.Null(store.SetDocument(Encoding.UTF8.GetBytes(Defaults)).Problem);

        using HttpResponseMessage response = await client.PutAsync(new Uri(ClientDefaultsPath, UriKind.Relative), CreateBody(document), cancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(ClientDefaultsProblem.InvalidCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Equal(4, store.GetSettings().Count);
    }

    [Fact]
    public async Task SetClientDefaults_DeepestAllowedValue_IsStored()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);
        string document = """{ "settings": { "nested": """ + new string('[', 14) + new string(']', 14) + " } }";

        using HttpResponseMessage response = await client.PutAsync(new Uri(ClientDefaultsPath, UriKind.Relative), CreateBody(document), cancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(JsonValueKind.Array, application.Services.GetRequiredService<ClientDefaultsStore>().GetSettings()["nested"].ValueKind);
    }

    [Fact]
    public async Task SetClientDefaults_OversizeDocument_IsTooLarge()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        await using WebApplication application = await StartServerAsync(cancellationToken);
        using HttpClient client = CreateClient(application, AdministratorRole);
        string document = """{ "settings": { "padding": " """ + new string('a', ClientDefaultsFunctions.MaximumByteLength) + "\" } }";

        using HttpResponseMessage response = await client.PutAsync(new Uri(ClientDefaultsPath, UriKind.Relative), CreateBody(document), cancellationToken);

        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, response.StatusCode);
        Assert.Equal(ClientDefaultsProblem.SizeCode, await ReadCodeAsync(response, cancellationToken));
        Assert.Empty(application.Services.GetRequiredService<ClientDefaultsStore>().GetSettings());
    }

    private static StringContent CreateBody(string document)
    {
        return new StringContent(document, Encoding.UTF8, JsonContentType);
    }

    private static async Task<string?> ReadCodeAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        using JsonDocument problem = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        return problem.RootElement.GetProperty("code").GetString();
    }

    private Task<WebApplication> StartServerAsync(CancellationToken cancellationToken)
    {
        return RoleHeaderTestServer.StartAsync(
            services => services.AddSingleton(new ClientDefaultsStore(dataFolder.FullName, NullLogger<ClientDefaultsStore>.Instance)),
            cancellationToken);
    }
}
