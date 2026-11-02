using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Security.Claims;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.WebGPUPlayer.DevHost;

/// <summary>
/// Signs a request in as the Jellyfin server's user whose credentials it carries, as the server's own authentication does: the server's <c>Users/Me</c> names the user and whether it is an administrator.
/// </summary>
internal sealed class ServerUserAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IHttpClientFactory httpClientFactory,
    IMemoryCache cache)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    /// <summary>
    /// The scheme's name.
    /// </summary>
    public const string SchemeName = "JellyfinServer";

    /// <summary>
    /// The role of the server's administrators, which the elevation policy requires.
    /// </summary>
    public const string AdministratorRole = "Administrator";

    /// <summary>
    /// The name of the HTTP client whose base address is the server's.
    /// </summary>
    public const string HttpClientName = "JellyfinServer";

    // The headers Jellyfin reads credentials from, forwarded as the request carries them
    private static readonly string[] CredentialHeaders = ["Authorization", "X-Emby-Authorization", "X-Emby-Token", "X-MediaBrowser-Token"];

    // The query keys Jellyfin reads a token from, forwarded as X-Emby-Token
    private static readonly string[] TokenQueryKeys = ["ApiKey", "api_key"];

    // How long one set of credentials keeps its answer; the add-on reads several routes per page
    private static readonly TimeSpan AnswerLifetime = TimeSpan.FromSeconds(30);

    /// <summary>
    /// Returns the base address of a server's address, with its base path ending in a slash, so relative routes stay below it.
    /// </summary>
    /// <param name="address">The server's address.</param>
    /// <returns>The base address.</returns>
    public static Uri GetBaseAddress(string address)
    {
        return new Uri(address.EndsWith('/') ? address : address + "/", UriKind.Absolute);
    }

    /// <inheritdoc />
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        List<KeyValuePair<string, string>> credentials = [];
        foreach (string name in CredentialHeaders)
        {
            if (Request.Headers.TryGetValue(name, out StringValues value) && !StringValues.IsNullOrEmpty(value))
            {
                credentials.Add(new(name, value.ToString()));
            }
        }

        foreach (string key in TokenQueryKeys)
        {
            if (Request.Query.TryGetValue(key, out StringValues value) && !StringValues.IsNullOrEmpty(value))
            {
                credentials.Add(new("X-Emby-Token", value.ToString()));
            }
        }

        if (credentials.Count == 0)
        {
            return AuthenticateResult.NoResult();
        }

        string cacheKey = string.Join('\n', credentials);
        ClaimsPrincipal? principal = await cache.GetOrCreateAsync(cacheKey, entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = AnswerLifetime;
            return ReadServerUserAsync(credentials);
        }).ConfigureAwait(false);
        return principal is null
            ? AuthenticateResult.Fail("The Jellyfin server refused the request's credentials")
            : AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName));
    }

    // The server's user of the credentials, or null when the server refuses them or the user is disabled; any other answer throws, and is not kept
    private async Task<ClaimsPrincipal?> ReadServerUserAsync(List<KeyValuePair<string, string>> credentials)
    {
        HttpClient client = httpClientFactory.CreateClient(HttpClientName);
        using HttpRequestMessage request = new HttpRequestMessage(HttpMethod.Get, new Uri("Users/Me", UriKind.Relative));
        foreach ((string name, string value) in credentials)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        using HttpResponseMessage response = await client.SendAsync(request, Context.RequestAborted).ConfigureAwait(false);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        using JsonDocument user = await JsonDocument.ParseAsync(
            await response.Content.ReadAsStreamAsync(Context.RequestAborted).ConfigureAwait(false),
            cancellationToken: Context.RequestAborted).ConfigureAwait(false);
        JsonElement root = user.RootElement;
        bool hasPolicy = root.TryGetProperty("Policy", out JsonElement policy);
        if (hasPolicy && IsTrue(policy, "IsDisabled"))
        {
            return null;
        }

        string userName = root.TryGetProperty("Name", out JsonElement nameElement) ? nameElement.GetString() ?? string.Empty : string.Empty;
        List<Claim> claims = [new Claim(ClaimTypes.Name, userName)];
        if (hasPolicy && IsTrue(policy, "IsAdministrator"))
        {
            claims.Add(new Claim(ClaimTypes.Role, AdministratorRole));
        }

        return new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
    }

    private static bool IsTrue(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out JsonElement value) && value.ValueKind == JsonValueKind.True;
    }
}
