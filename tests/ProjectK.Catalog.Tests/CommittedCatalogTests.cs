using System.Text.Json;

namespace ProjectK.Catalog.Tests;

/// <summary>Guards the converted catalog in <c>catalog/</c>: it must stay valid, and it must keep
/// every id Lilejka already stores progress against.</summary>
public class CommittedCatalogTests
{
    private static readonly string RepoRoot = FindRepoRoot();
    private static readonly CatalogPackage Catalog = CatalogPackage.ReadFolder(Path.Combine(RepoRoot, "catalog"));

    [Fact]
    public void CommittedCatalog_IsValid()
    {
        var report = Catalog.Validate();

        Assert.True(report.IsValid, string.Join('\n', report.Errors));
    }

    [Fact]
    public void CommittedCatalog_KeepsEveryV1ProbePointId()
    {
        using var v1 = JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "src/ProjectK.ProbeAndBadges/Data/probes.seed.json")));
        var v1PointIds = v1.RootElement.GetProperty("Probes").EnumerateArray()
            .SelectMany(p => p.GetProperty("Points").EnumerateArray()
                .Concat(p.TryGetProperty("Sections", out var sections)
                    ? sections.EnumerateArray().SelectMany(s => s.GetProperty("Points").EnumerateArray())
                    : []))
            .Select(point => point.GetProperty("Id").GetString()!)
            .ToList();

        var v2PointIds = Catalog.Bundle.Probes.SelectMany(CatalogValidator.AllPoints).Select(p => p.Id).ToHashSet();

        Assert.NotEmpty(v1PointIds);
        Assert.All(v1PointIds, id => Assert.Contains(id, v2PointIds));
    }

    [Fact]
    public void CommittedCatalog_KeepsV1SeedBadgeIds()
    {
        using var v1 = JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "src/ProjectK.ProbeAndBadges/Data/badges.seed.json")));
        var ids = Catalog.Bundle.Badges.Select(b => b.Id).ToHashSet();

        foreach (var badge in v1.RootElement.GetProperty("Badges").EnumerateArray())
        {
            Assert.Contains(badge.GetProperty("Id").GetString()!, ids);
        }
    }

    [Fact]
    public void CommittedCatalog_HasEveryUpyuAwardLevelWithBothImages()
    {
        var awards = Catalog.Bundle.Awards.Where(a => a.Group == "upyu-vidznachennia").OrderBy(a => a.Level).ToList();

        Assert.Equal([1, 2, 3, 4], awards.Select(a => a.Level!.Value));
        Assert.All(awards, a =>
        {
            Assert.True(Catalog.Images.ContainsKey(a.Images.Color!));
            Assert.True(Catalog.Images.ContainsKey(a.Images.Bw!));
        });
    }

    [Fact]
    public void CommittedCatalog_HasBothFormsOfEveryGenderedDegreeWithBothImages()
    {
        Assert.NotEmpty(Catalog.Bundle.Degrees);
        Assert.All(Catalog.Bundle.Degrees, d =>
        {
            Assert.True(Catalog.Images.ContainsKey(d.Images.Color!), d.Id);
            Assert.True(Catalog.Images.ContainsKey(d.Images.Bw!), d.Id);
        });

        foreach (var family in Catalog.Bundle.Degrees.Where(d => d.Gender is not null).GroupBy(d => d.Family))
        {
            Assert.Equal(["female", "male"], family.Select(d => d.Gender!).Order());
        }
    }

    [Fact]
    public void KraiContributionExample_IsValidAgainstTheCatalog()
    {
        var example = CatalogPackage.ReadFolder(Path.Combine(RepoRoot, "samples/krai-contribution"));

        var report = example.Validate(Catalog.Bundle, Catalog.ImageNames);

        Assert.True(report.IsValid, string.Join('\n', report.Errors));
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "ProjectK.ProbeAndBadges.slnx")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName ?? throw new InvalidOperationException("Repository root not found.");
    }
}
