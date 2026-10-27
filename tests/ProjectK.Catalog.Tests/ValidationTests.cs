using System.IO.Compression;
using System.Text;

namespace ProjectK.Catalog.Tests;

public class ValidationTests
{
    private static CatalogBundle Base() => new()
    {
        Categories = [new CatalogCategory { Id = "mystetska", Title = "Мистецька" }],
        Badges =
        [
            new BadgeDefinition
            {
                Id = "aktorstvo-i",
                Title = "Акторство I",
                Krai = "ua",
                Ulady = ["upyu"],
                Categories = ["mystetska"],
                Images = new ImageSet { Color = "a1.svg" },
                Requirements = [new Requirement { Id = "1", Text = "Прочитати п'єсу." }],
            },
        ],
        Probes =
        [
            new ProbeDefinition
            {
                Id = "probe-1",
                Title = "Перша проба",
                Krai = "ua",
                Sections = [new ProbeSection { Id = "probe-1-a", Code = "А", Title = "А", Points = [new ProbePoint { Id = "probe-1-a-1", Text = "Знає" }] }],
            },
        ],
    };

    [Fact]
    public void Base_IsValid()
    {
        var report = CatalogValidator.Validate(Base(), new HashSet<string> { "a1.svg" });

        Assert.True(report.IsValid, string.Join('\n', report.Errors));
    }

    [Fact]
    public void NewEdition_StandsBesideTheOldOne_AtTheSamePlaces()
    {
        var contribution = new CatalogBundle
        {
            Editions = [new ProbeEdition { Id = "upyu-2026", Title = "Оновлена проба (2026)", Krai = "ua" }],
            Probes =
            [
                new ProbeDefinition { Id = "znak-2026", Title = "Знак прихильника", Krai = "ua", Edition = "upyu-2026", Order = 0, Status = "trial" },
                new ProbeDefinition
                {
                    Id = "probe-1-2026",
                    Title = "Перша проба",
                    Krai = "ua",
                    Edition = "upyu-2026",
                    Order = 1,
                    Status = "trial",
                    Points = [new ProbePoint { Id = "probe-1-2026-1", Text = "Знає закон", Level = "knows", Competencies = ["hromadianska"] }],
                },
            ],
        };

        var report = CatalogValidator.Validate(contribution, new HashSet<string>(), Base());

        Assert.Empty(report.Issues);
    }

    [Fact]
    public void Probe_NamesAnEditionThatExists_ForItsOwnUladAndKrai()
    {
        ProbeDefinition Probe(string edition, string krai = "ua") => new() { Id = $"p-{edition}-{krai}", Title = "x", Krai = krai, Edition = edition, Order = 1 };
        var contribution = new CatalogBundle
        {
            Editions =
            [
                new ProbeEdition { Id = "upyu-2026", Title = "Оновлена проба (2026)", Krai = "ua" },
                new ProbeEdition { Id = "usp-2026", Title = "Нова", Ulad = "usp", Krai = "ua" },
            ],
            Probes = [Probe("nemaie"), Probe("usp-2026"), Probe("upyu-2026", "cz")],
        };

        var messages = CatalogValidator.Validate(contribution, new HashSet<string>(), Base()).Errors.Select(e => e.Message).ToList();

        Assert.Contains(messages, m => m.Contains("Unknown edition 'nemaie'"));
        Assert.Contains(messages, m => m.Contains("is for usp, the probe for upyu"));
        Assert.Contains(messages, m => m.Contains("belongs to krai 'ua', the probe to 'cz'"));
    }

    [Fact]
    public void Edition_IsRenamedOnItsOwn_ButNotMovedAwayFromItsStoredProbes()
    {
        var stored = Base() with
        {
            Editions = [new ProbeEdition { Id = "upyu-2026", Title = "Нова програма", Krai = "ua" }],
            Probes = [.. Base().Probes, new ProbeDefinition { Id = "probe-1-2026", Title = "Перша", Krai = "ua", Edition = "upyu-2026", Order = 1 }],
        };
        var renamed = new ProbeEdition { Id = "upyu-2026", Title = "Оновлена проба (2026)", Krai = "ua" };

        var rename = CatalogValidator.Validate(new CatalogBundle { Editions = [renamed] }, new HashSet<string>(), stored);
        var move = CatalogValidator.Validate(new CatalogBundle { Editions = [renamed with { Ulad = "usp" }] }, new HashSet<string>(), stored);

        Assert.True(rename.IsValid, string.Join('\n', rename.Errors));
        Assert.Contains(move.Errors, e => e.Message.Contains("Probe probe-1-2026 (upyu, ua) belongs to this edition"));
    }

    [Fact]
    public void TwoLiveProbes_MayNotShareAPlaceInOneEdition()
    {
        var copy = new ProbeDefinition { Id = "probe-1-copy", Title = "Ще одна", Krai = "ua" };

        var clash = CatalogValidator.Validate(new CatalogBundle { Probes = [copy] }, new HashSet<string>(), Base());
        var retired = CatalogValidator.Validate(new CatalogBundle { Probes = [copy with { Status = "retired" }] }, new HashSet<string>(), Base());

        Assert.Contains(clash.Errors, e => e.Message.Contains("Probe probe-1 already stands at 0"));
        Assert.True(retired.IsValid, string.Join('\n', retired.Errors));
    }

    [Fact]
    public void Point_LevelAndCompetencies_AreChecked()
    {
        var contribution = new CatalogBundle
        {
            Probes =
            [
                new ProbeDefinition
                {
                    Id = "probe-x",
                    Title = "x",
                    Krai = "ua",
                    Edition = "Upyu 2026",
                    Order = 5,
                    Points = [new ProbePoint { Id = "probe-x-1", Text = "x", Level = "masters", Competencies = ["a", "a"] }],
                },
            ],
        };

        var paths = CatalogValidator.Validate(contribution, new HashSet<string>(), Base()).Errors.Select(e => e.Path).ToList();

        Assert.Contains("probes[0].edition", paths);
        Assert.Contains("probes[0].points[0].level", paths);
        Assert.Contains("probes[0].points[0].competencies", paths);
    }

    [Fact]
    public void Contribution_MayOverrideBaseItems_WithKraiPrefixedIds()
    {
        var contribution = new CatalogBundle
        {
            Source = new BundleSource { Krai = "cz" },
            Overrides =
            [
                new CatalogOverride
                {
                    Krai = "cz",
                    Target = "probe:probe-1",
                    AddPoints = [new OverridePoint { Section = "А", Id = "cz-probe-1-a-1", Text = "Знає історію Пласту в Чехії" }],
                },
            ],
        };

        var report = CatalogValidator.Validate(contribution, new HashSet<string>(), Base());

        Assert.True(report.IsValid, string.Join('\n', report.Errors));
    }

    [Fact]
    public void Contribution_RejectsUnprefixedIds_UnknownSections_AndForeignKrai()
    {
        var contribution = new CatalogBundle
        {
            Source = new BundleSource { Krai = "cz" },
            Overrides =
            [
                new CatalogOverride
                {
                    Krai = "pl",
                    Target = "probe:probe-1",
                    AddPoints = [new OverridePoint { Section = "Я", Id = "point-x", Text = "x" }],
                },
            ],
        };

        var errors = CatalogValidator.Validate(contribution, new HashSet<string>(), Base()).Errors.Select(e => e.Message).ToList();

        Assert.Contains(errors, m => m.Contains("may only carry its own overrides", StringComparison.Ordinal));
        Assert.Contains(errors, m => m.Contains("must start with 'pl-'", StringComparison.Ordinal));
        Assert.Contains(errors, m => m.Contains("no section 'Я'", StringComparison.Ordinal));
    }

    [Fact]
    public void Contribution_CannotTakeOverAnotherKraisBadge()
    {
        var contribution = new CatalogBundle
        {
            Source = new BundleSource { Krai = "cz" },
            Badges = [Base().Badges[0] with { Krai = null }],
        };

        var report = CatalogValidator.Validate(contribution, new HashSet<string> { "a1.svg" }, Base());

        Assert.Contains(report.Errors, e => e.Message.Contains("already belongs to krai 'ua'", StringComparison.Ordinal));
    }

    [Fact]
    public void Validate_RejectsDuplicatePointIds_UnknownPrerequisites_AndMissingImages()
    {
        var bundle = Base() with
        {
            Badges = [Base().Badges[0] with { Prerequisites = ["nema"], Images = new ImageSet { Color = "missing.svg" } }],
            Probes =
            [
                Base().Probes[0],
                Base().Probes[0] with { Id = "probe-2", Sections = [Base().Probes[0].Sections[0] with { Id = "probe-2-a" }] },
            ],
        };

        var errors = CatalogValidator.Validate(bundle, new HashSet<string>()).Errors.Select(e => e.Message).ToList();

        Assert.Contains(errors, m => m.Contains("Unknown badge 'nema'", StringComparison.Ordinal));
        Assert.Contains(errors, m => m.Contains("'missing.svg' is not in images/", StringComparison.Ordinal));
        Assert.Contains(errors, m => m.Contains("'probe-1-a-1' is used twice", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("<svg><script>alert(1)</script></svg>")]
    [InlineData("<svg><rect onload=\"x()\"/></svg>")]
    [InlineData("<svg><image href=\"https://evil.example/x.png\"/></svg>")]
    [InlineData("<svg><foreignObject/></svg>")]
    public void ImageSafety_RejectsActiveSvg(string svg)
    {
        var issues = ImageSafety.Check("x.svg", Encoding.UTF8.GetBytes(svg));

        Assert.Contains(issues, i => i.IsError);
    }

    [Fact]
    public void ImageSafety_AcceptsPlainSvg_AndRejectsPngThatIsNotPng()
    {
        Assert.DoesNotContain(ImageSafety.Check("x.svg", "<svg><path d=\"M0 0\"/><use xlink:href=\"#a\"/></svg>"u8.ToArray()), i => i.IsError);
        Assert.Contains(ImageSafety.Check("x.png", "<svg/>"u8.ToArray()), i => i.IsError);
    }

    [Fact]
    public void ReadZip_AcceptsOneTopFolder_AndIgnoresMacJunk()
    {
        var zip = Zip(
            ("prague/catalog.json", CatalogJson.Serialize(new CatalogBundle { Source = new BundleSource { Krai = "cz" } })),
            ("prague/images/a.svg", "<svg/>"),
            ("__MACOSX/prague/._a.svg", "junk"));

        var package = CatalogPackage.ReadZip(zip);

        Assert.Equal("cz", package.Bundle.Source!.Krai);
        Assert.Equal(["a.svg"], package.Images.Keys);
    }

    [Theory]
    [InlineData("../catalog.json")]
    [InlineData("images/../../x.svg")]
    [InlineData("images/sub/x.svg")]
    [InlineData("script.js")]
    public void ReadZip_RejectsAnythingButCatalogAndFlatImages(string entry)
    {
        var zip = Zip(("catalog.json", CatalogJson.Serialize(new CatalogBundle())), (entry, "x"));

        Assert.Throws<InvalidDataException>(() => CatalogPackage.ReadZip(zip));
    }

    [Fact]
    public void Deserialize_RejectsUnknownFields()
    {
        Assert.ThrowsAny<System.Text.Json.JsonException>(() => CatalogJson.Deserialize("""{ "schemaVersion": 2, "badgez": [] }"""));
    }

    private static MemoryStream Zip(params (string Name, string Content)[] entries)
    {
        var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var (name, content) in entries)
            {
                using var writer = new StreamWriter(archive.CreateEntry(name).Open());
                writer.Write(content);
            }
        }

        stream.Position = 0;
        return stream;
    }
}
