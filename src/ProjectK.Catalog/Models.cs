namespace ProjectK.Catalog;

/// <summary>
/// One catalog file (<c>catalog.json</c>) in format v2. The same shape is used for the whole
/// catalog, for a krai's contribution sent as a zip, and for the snapshot published to the CDN.
/// Image fields hold file names relative to the bundle's <c>images/</c> folder.
/// </summary>
public sealed record CatalogBundle
{
    public const int CurrentSchemaVersion = 2;

    public int SchemaVersion { get; init; } = CurrentSchemaVersion;

    /// <summary>Who prepared this bundle. For a krai contribution, <see cref="BundleSource.Krai"/>
    /// is the default krai of every item that does not name its own.</summary>
    public BundleSource? Source { get; init; }

    public List<CatalogCategory> Categories { get; init; } = [];
    public List<ProbeEdition> Editions { get; init; } = [];
    public List<BadgeDefinition> Badges { get; init; } = [];
    public List<ProbeDefinition> Probes { get; init; } = [];
    public List<DegreeDefinition> Degrees { get; init; } = [];
    public List<AwardDefinition> Awards { get; init; } = [];
    public List<CatalogOverride> Overrides { get; init; } = [];
}

public sealed record BundleSource
{
    public string? Krai { get; init; }
    public string? Name { get; init; }
    public string? Contact { get; init; }
    public string? Generator { get; init; }
    public DateTimeOffset? GeneratedAtUtc { get; init; }
}

public sealed record CatalogCategory
{
    public required string Id { get; init; }
    public required string Title { get; init; }
}

public sealed record ImageSet
{
    /// <summary>Coloured variant, the one shown by default.</summary>
    public string? Color { get; init; }

    /// <summary>Black-and-white variant, shown while the item is not yet earned.</summary>
    public string? Bw { get; init; }
}

public sealed record Requirement
{
    /// <summary>Stable within its item ("1", "2", ...). Items added by a krai override are
    /// prefixed with the krai code ("cz-1") so they never collide with the base list.</summary>
    public required string Id { get; init; }

    /// <summary>Markdown.</summary>
    public required string Text { get; init; }
}

/// <summary>Вмілість.</summary>
public sealed record BadgeDefinition
{
    /// <summary>Stable slug. Lilejka stores progress against it, so it never changes.</summary>
    public required string Id { get; init; }

    /// <summary>Groups the levels of one badge: "aktorstvo" for Акторство I, II, III.</summary>
    public string? Family { get; init; }

    public int? Level { get; init; }
    public required string Title { get; init; }

    /// <summary>Ids of <see cref="CatalogCategory"/> (спеціалізації); a badge may sit in several.</summary>
    public List<string> Categories { get; init; } = [];

    /// <summary>Ulady the badge is meant for, see <see cref="CatalogCodes.Ulady"/>.</summary>
    public List<string> Ulady { get; init; } = [];

    /// <summary>Krai that approved the badge ("ua" for КПС in Ukraine, "pl", "cz", ...).</summary>
    public string? Krai { get; init; }

    public string Status { get; init; } = CatalogCodes.StatusApproved;
    public ImageSet Images { get; init; } = new();

    /// <summary>Badges that must be earned first.</summary>
    public List<string> Prerequisites { get; init; } = [];

    public List<Requirement> Requirements { get; init; } = [];
    public string? InstructorRequirements { get; init; }
    public string? Author { get; init; }

    /// <summary>ISO date (yyyy-MM-dd) of the last change to the badge's text.</summary>
    public string? UpdatedOn { get; init; }

    /// <summary>Free-form notes for editors, never shown to members.</summary>
    public List<string> Notes { get; init; } = [];
}

/// <summary>Проба.</summary>
public sealed record ProbeDefinition
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public string Ulad { get; init; } = CatalogCodes.UladYouth;
    public string? Krai { get; init; }

    /// <summary>
    /// Id of the <see cref="ProbeEdition"/>, e.g. "upyu-2026". Two editions run side by side while a krai
    /// moves over, and <see cref="Order"/> counts within one. Probes from before editions were named
    /// leave it out, and together they are one edition too.
    /// </summary>
    public string? Edition { get; init; }

    public int Order { get; init; }
    public string Status { get; init; } = CatalogCodes.StatusApproved;
    public ImageSet Images { get; init; } = new();
    public List<ProbeSection> Sections { get; init; } = [];

    /// <summary>Points that belong to no section.</summary>
    public List<ProbePoint> Points { get; init; } = [];
}

/// <summary>
/// An edition of a ulad's probes and the name people see for it, e.g. "upyu-2026" → "Оновлена
/// проба (2026)". Probes join it through <see cref="ProbeDefinition.Edition"/>. The edition from
/// before editions were named has no entry: Lilejka names it itself.
/// </summary>
public sealed record ProbeEdition
{
    public required string Id { get; init; }

    /// <summary>Shown to people as it is.</summary>
    public required string Title { get; init; }

    public string Ulad { get; init; } = CatalogCodes.UladYouth;
    public string? Krai { get; init; }
}

public sealed record ProbeSection
{
    public required string Id { get; init; }

    /// <summary>Letter shown to members: А, Б, В, ...</summary>
    public required string Code { get; init; }

    public required string Title { get; init; }
    public List<ProbePoint> Points { get; init; } = [];
}

public sealed record ProbePoint
{
    /// <summary>Globally unique. Lilejka stores progress against it, so it never changes.</summary>
    public required string Id { get; init; }

    public required string Text { get; init; }

    /// <summary>How deep the point goes in the 2026 УПЮ programme: one of
    /// <see cref="CatalogCodes.PointLevels"/>. Older probes leave it out.</summary>
    public string? Level { get; init; }

    /// <summary>Ids of the competences the point builds.</summary>
    public List<string>? Competencies { get; init; }
}

/// <summary>
/// Ступінь and the badge worn for it on the left sleeve: старший пластун, пластун сеніор праці,
/// пластунка вірлиця, ... The men's and the women's form of a degree are two entries, because their
/// badges differ (the sand-coloured shield goes with a пластунка's shirt); <see cref="Family"/>
/// joins them.
/// </summary>
public sealed record DegreeDefinition
{
    /// <summary>Stable slug. Lilejka stores who holds the degree against it, so it never changes.</summary>
    public required string Id { get; init; }

    /// <summary>Joins the forms of one degree: "ups-pratsi" for сеніор праці and сеніорка праці.</summary>
    public string? Family { get; init; }

    public required string Title { get; init; }

    /// <summary>Ulad that grants the degree, see <see cref="CatalogCodes.Ulady"/>.</summary>
    public string Ulad { get; init; } = CatalogCodes.UladYouth;

    public string? Krai { get; init; }

    /// <summary>"male" or "female" when the entry is one form of the degree; left out when the
    /// degree is the same for everybody.</summary>
    public string? Gender { get; init; }

    /// <summary>Place on the ulad's ladder, from 0. Forms of one degree share it, and so do side
    /// branches such as скоб-гребець next to скоб.</summary>
    public int Order { get; init; }

    /// <summary>Other ulady whose members may keep wearing the badge instead of their own: a скоб
    /// wears his in УСП.</summary>
    public List<string> WornIn { get; init; } = [];

    public string Status { get; init; } = CatalogCodes.StatusApproved;
    public ImageSet Images { get; init; } = new();

    /// <summary>Markdown: who grants the degree, on what conditions, how the badge looks.</summary>
    public string? Description { get; init; }

    public List<Requirement> Requirements { get; init; } = [];
}

/// <summary>
/// Відзначення, відзнака or вишкіл with a badge: УПЮ відзначення, КВ, ЗБ, ЛШ, ШБ and whatever
/// comes next. <see cref="Group"/> tells them apart, so a new kind needs no schema change.
/// </summary>
public sealed record AwardDefinition
{
    public required string Id { get; init; }

    /// <summary>One ladder each: "orden-sv-yuriia", "orden-vichnoho-vohniu", "khresty", "kv-upn", "kv-upyu",
    /// "lsh", "shb", "zb", "kvdch", "upyu-vidznachennia", "usp-vidznachennia", "ups-vidznachennia", ...</summary>
    public required string Group { get; init; }

    public required string Title { get; init; }
    public string? Ulad { get; init; }
    public string? Krai { get; init; }
    public int? Level { get; init; }
    public string Status { get; init; } = CatalogCodes.StatusApproved;
    public ImageSet Images { get; init; } = new();
    public string? Description { get; init; }
    public List<Requirement> Requirements { get; init; } = [];
}

/// <summary>
/// What one krai changes in an item it did not author: extra or replaced requirements, extra
/// probe points, or hiding the item. Applied on top of the base item when the catalog is
/// resolved for that krai; the base item stays untouched for everybody else.
/// </summary>
public sealed record CatalogOverride
{
    public required string Krai { get; init; }

    /// <summary>"badge:{id}", "probe:{id}", "degree:{id}" or "award:{id}".</summary>
    public required string Target { get; init; }

    public bool Hidden { get; init; }
    public string? Title { get; init; }
    public List<Requirement> AddRequirements { get; init; } = [];
    public List<string> RemoveRequirements { get; init; } = [];
    public List<OverridePoint> AddPoints { get; init; } = [];
    public List<string> RemovePoints { get; init; } = [];
    public string? Note { get; init; }
}

public sealed record OverridePoint
{
    /// <summary>Section code the point goes to; empty for the probe's unsectioned points.</summary>
    public string? Section { get; init; }

    public required string Id { get; init; }
    public required string Text { get; init; }
}

public static class CatalogCodes
{
    public const string StatusApproved = "approved";
    public const string StatusTrial = "trial";
    public const string StatusRetired = "retired";

    public static readonly IReadOnlySet<string> Statuses =
        new HashSet<string>(StringComparer.Ordinal) { StatusApproved, StatusTrial, StatusRetired };

    public const string UladYouth = "upyu";

    /// <summary>УПП (пташата), УПН (новацтво), УПЮ (юнацтво), УСП (старші пластуни), УПС (сеніори).</summary>
    public static readonly IReadOnlySet<string> Ulady =
        new HashSet<string>(StringComparer.Ordinal) { "upp", "upn", UladYouth, "usp", "ups" };

    /// <summary>Знає (tell about it), вміє (do it once or twice), практикує (do it with ease).</summary>
    public static readonly IReadOnlySet<string> PointLevels =
        new HashSet<string>(StringComparer.Ordinal) { "knows", "can", "practises" };

    public static readonly IReadOnlySet<string> Genders =
        new HashSet<string>(StringComparer.Ordinal) { "male", "female" };

    public const string TargetBadge = "badge";
    public const string TargetProbe = "probe";
    public const string TargetDegree = "degree";
    public const string TargetAward = "award";
}
