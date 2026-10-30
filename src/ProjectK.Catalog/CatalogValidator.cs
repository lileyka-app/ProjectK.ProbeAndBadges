using System.Text.RegularExpressions;

namespace ProjectK.Catalog;

public sealed record CatalogIssue(string Severity, string Path, string Message)
{
    public const string SeverityError = "error";
    public const string SeverityWarning = "warning";

    public static CatalogIssue Error(string path, string message) => new(SeverityError, path, message);
    public static CatalogIssue Warning(string path, string message) => new(SeverityWarning, path, message);

    public bool IsError => Severity == SeverityError;

    public override string ToString() => $"{Severity}: {Path}: {Message}";
}

public sealed class ValidationReport
{
    public List<CatalogIssue> Issues { get; } = [];

    public IEnumerable<CatalogIssue> Errors => Issues.Where(i => i.IsError);
    public IEnumerable<CatalogIssue> Warnings => Issues.Where(i => !i.IsError);
    public bool IsValid => !Issues.Any(i => i.IsError);
}

/// <summary>
/// Checks a bundle on its own or as a contribution to an existing catalog. With a
/// <c>reference</c>, prerequisites, categories and override targets may point at items that
/// exist only there, and ids that are already taken there by another krai are rejected.
/// </summary>
public static partial class CatalogValidator
{
    [GeneratedRegex("^[a-z0-9]+(-[a-z0-9]+)*$")]
    private static partial Regex SlugPattern();

    [GeneratedRegex("^[a-z]{2,3}$")]
    private static partial Regex KraiPattern();

    [GeneratedRegex(@"^\d{4}-\d{2}-\d{2}$")]
    private static partial Regex DatePattern();

    public static bool IsSlug(string? value) => value is not null && SlugPattern().IsMatch(value);
    public static bool IsKrai(string? value) => value is not null && KraiPattern().IsMatch(value);

    public static ValidationReport Validate(
        CatalogBundle bundle,
        IReadOnlySet<string>? availableImages = null,
        CatalogBundle? reference = null)
    {
        var report = new ValidationReport();
        var issues = report.Issues;

        if (bundle.SchemaVersion != CatalogBundle.CurrentSchemaVersion)
        {
            issues.Add(CatalogIssue.Error("schemaVersion", $"Expected {CatalogBundle.CurrentSchemaVersion}, got {bundle.SchemaVersion}."));
            return report;
        }

        if (bundle.Source?.Krai is { } sourceKrai && !IsKrai(sourceKrai))
        {
            issues.Add(CatalogIssue.Error("source.krai", "Krai is a 2–3 letter lowercase code: ua, pl, cz, de, ..."));
        }

        var categoryIds = Ids(bundle.Categories.Select(c => c.Id), reference?.Categories.Select(c => c.Id));
        var badgeIds = Ids(bundle.Badges.Select(b => b.Id), reference?.Badges.Select(b => b.Id));
        var probeIds = Ids(bundle.Probes.Select(p => p.Id), reference?.Probes.Select(p => p.Id));
        var degreeIds = Ids(bundle.Degrees.Select(d => d.Id), reference?.Degrees.Select(d => d.Id));
        var awardIds = Ids(bundle.Awards.Select(a => a.Id), reference?.Awards.Select(a => a.Id));

        CheckUnique(issues, "categories", bundle.Categories.Select(c => c.Id));
        CheckUnique(issues, "editions", bundle.Editions.Select(p => p.Id));
        CheckUnique(issues, "badges", bundle.Badges.Select(b => b.Id));
        CheckUnique(issues, "probes", bundle.Probes.Select(p => p.Id));
        CheckUnique(issues, "degrees", bundle.Degrees.Select(d => d.Id));
        CheckUnique(issues, "awards", bundle.Awards.Select(a => a.Id));

        for (var i = 0; i < bundle.Categories.Count; i++)
        {
            var category = bundle.Categories[i];
            var path = $"categories[{i}]";
            RequireSlug(issues, path + ".id", category.Id);
            RequireText(issues, path + ".title", category.Title);
        }

        // The bundle's own editions win over stored ones with the same id: that is how one is renamed.
        var editions = new Dictionary<string, ProbeEdition>(StringComparer.Ordinal);
        foreach (var edition in (reference?.Editions ?? []).Concat(bundle.Editions)) editions[edition.Id] = edition;
        for (var i = 0; i < bundle.Editions.Count; i++)
        {
            ValidateEdition(issues, bundle, bundle.Editions[i], $"editions[{i}]", reference);
        }

        for (var i = 0; i < bundle.Badges.Count; i++)
        {
            ValidateBadge(issues, bundle, bundle.Badges[i], $"badges[{i}]", badgeIds, categoryIds, availableImages, reference);
        }

        var pointIds = new HashSet<string>(StringComparer.Ordinal);
        if (reference is not null)
        {
            var bundleProbeIds = bundle.Probes.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var probe in reference.Probes.Where(p => !bundleProbeIds.Contains(p.Id)))
            {
                pointIds.UnionWith(AllPoints(probe).Select(p => p.Id));
            }
        }

        for (var i = 0; i < bundle.Probes.Count; i++)
        {
            ValidateProbe(issues, bundle, bundle.Probes[i], $"probes[{i}]", pointIds, editions, availableImages, reference);
        }

        ValidateProbeOrders(issues, bundle, reference);

        for (var i = 0; i < bundle.Degrees.Count; i++)
        {
            ValidateDegree(issues, bundle, bundle.Degrees[i], $"degrees[{i}]", availableImages, reference);
        }

        for (var i = 0; i < bundle.Awards.Count; i++)
        {
            ValidateAward(issues, bundle, bundle.Awards[i], $"awards[{i}]", availableImages, reference);
        }

        var overrideKeys = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < bundle.Overrides.Count; i++)
        {
            var path = $"overrides[{i}]";
            var o = bundle.Overrides[i];
            if (!overrideKeys.Add($"{o.Krai}|{o.Target}"))
            {
                issues.Add(CatalogIssue.Error(path, $"Second override of {o.Target} for krai '{o.Krai}'; merge them into one."));
            }

            ValidateOverride(issues, bundle, reference, o, path, badgeIds, probeIds, degreeIds, awardIds);
        }

        return report;
    }

    private static void ValidateBadge(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        BadgeDefinition badge,
        string path,
        HashSet<string> badgeIds,
        HashSet<string> categoryIds,
        IReadOnlySet<string>? availableImages,
        CatalogBundle? reference)
    {
        RequireSlug(issues, path + ".id", badge.Id);
        RequireText(issues, path + ".title", badge.Title);
        if (badge.Family is not null) RequireSlug(issues, path + ".family", badge.Family);
        if (badge.Level is < 1 or > 5) issues.Add(CatalogIssue.Error(path + ".level", "Level is 1–5."));
        if (badge.Categories.Count == 0) issues.Add(CatalogIssue.Warning(path + ".categories", "Badge has no category."));
        foreach (var category in badge.Categories.Where(c => !categoryIds.Contains(c)))
        {
            issues.Add(CatalogIssue.Error(path + ".categories", $"Unknown category '{category}'."));
        }
        if (badge.Ulady.Count == 0) issues.Add(CatalogIssue.Warning(path + ".ulady", "Badge names no ulad."));
        foreach (var ulad in badge.Ulady.Where(u => !CatalogCodes.Ulady.Contains(u)))
        {
            issues.Add(CatalogIssue.Error(path + ".ulady", $"Unknown ulad '{ulad}'; use one of {string.Join(", ", CatalogCodes.Ulady)}."));
        }

        ValidateKraiAndOwnership(issues, bundle, reference, path, badge.Krai, reference?.Badges.FirstOrDefault(b => b.Id == badge.Id)?.Krai);
        ValidateStatus(issues, path, badge.Status);
        ValidateImages(issues, path, badge.Images, availableImages, required: true);
        ValidateRequirements(issues, path + ".requirements", badge.Requirements, required: true);

        foreach (var prerequisite in badge.Prerequisites)
        {
            if (prerequisite == badge.Id) issues.Add(CatalogIssue.Error(path + ".prerequisites", "Badge cannot require itself."));
            else if (!badgeIds.Contains(prerequisite)) issues.Add(CatalogIssue.Error(path + ".prerequisites", $"Unknown badge '{prerequisite}'."));
        }

        if (badge.UpdatedOn is not null && (!DatePattern().IsMatch(badge.UpdatedOn) || !DateOnly.TryParse(badge.UpdatedOn, out _)))
        {
            issues.Add(CatalogIssue.Error(path + ".updatedOn", "Date is yyyy-MM-dd."));
        }
    }

    private static void ValidateProbe(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        ProbeDefinition probe,
        string path,
        HashSet<string> pointIds,
        IReadOnlyDictionary<string, ProbeEdition> editions,
        IReadOnlySet<string>? availableImages,
        CatalogBundle? reference)
    {
        RequireSlug(issues, path + ".id", probe.Id);
        RequireText(issues, path + ".title", probe.Title);
        if (!CatalogCodes.Ulady.Contains(probe.Ulad)) issues.Add(CatalogIssue.Error(path + ".ulad", $"Unknown ulad '{probe.Ulad}'."));
        ValidateKraiAndOwnership(issues, bundle, reference, path, probe.Krai, reference?.Probes.FirstOrDefault(p => p.Id == probe.Id)?.Krai);
        if (probe.Edition is not null) ValidateProbeEdition(issues, bundle, probe, path + ".edition", editions.GetValueOrDefault(probe.Edition));
        if (probe.Order < 0) issues.Add(CatalogIssue.Error(path + ".order", "Order is a whole number from 0; знак прихильника goes first with 0."));
        ValidateStatus(issues, path, probe.Status);
        ValidateImages(issues, path, probe.Images, availableImages, required: false);
        CheckUnique(issues, path + ".sections", probe.Sections.Select(s => s.Code));

        for (var s = 0; s < probe.Sections.Count; s++)
        {
            var section = probe.Sections[s];
            RequireText(issues, $"{path}.sections[{s}].code", section.Code);
            RequireText(issues, $"{path}.sections[{s}].title", section.Title);
            RequireSlug(issues, $"{path}.sections[{s}].id", section.Id);
            ValidatePoints(issues, $"{path}.sections[{s}].points", section.Points, pointIds);
        }

        ValidatePoints(issues, path + ".points", probe.Points, pointIds);
    }

    private static void ValidateEdition(List<CatalogIssue> issues, CatalogBundle bundle, ProbeEdition edition, string path, CatalogBundle? reference)
    {
        RequireSlug(issues, path + ".id", edition.Id);
        RequireText(issues, path + ".title", edition.Title);
        if (!CatalogCodes.Ulady.Contains(edition.Ulad)) issues.Add(CatalogIssue.Error(path + ".ulad", $"Unknown ulad '{edition.Ulad}'."));
        ValidateKraiAndOwnership(issues, bundle, reference, path, edition.Krai, reference?.Editions.FirstOrDefault(p => p.Id == edition.Id)?.Krai);

        // Stored probes the bundle does not resend have to keep fitting the edition they name.
        var resent = bundle.Probes.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        var krai = edition.Krai ?? bundle.Source?.Krai;
        foreach (var probe in (reference?.Probes ?? []).Where(p => p.Edition == edition.Id && !resent.Contains(p.Id)))
        {
            if (probe.Ulad != edition.Ulad || probe.Krai != krai)
            {
                issues.Add(CatalogIssue.Error(path, $"Probe {probe.Id} ({probe.Ulad}, {probe.Krai ?? "—"}) belongs to this edition; move it first."));
            }
        }
    }

    /// <summary>A probe names an edition that exists, and one of its own ulad and krai.</summary>
    private static void ValidateProbeEdition(List<CatalogIssue> issues, CatalogBundle bundle, ProbeDefinition probe, string path, ProbeEdition? edition)
    {
        RequireSlug(issues, path, probe.Edition!);
        if (edition is null)
        {
            issues.Add(CatalogIssue.Error(path, $"Unknown edition '{probe.Edition}'; add it under editions with the title people see."));
            return;
        }

        var editionKrai = edition.Krai ?? bundle.Source?.Krai;
        var probeKrai = probe.Krai ?? bundle.Source?.Krai;
        if (edition.Ulad != probe.Ulad) issues.Add(CatalogIssue.Error(path, $"Edition '{edition.Id}' is for {edition.Ulad}, the probe for {probe.Ulad}."));
        if (editionKrai != probeKrai) issues.Add(CatalogIssue.Error(path, $"Edition '{edition.Id}' belongs to krai '{editionKrai ?? "—"}', the probe to '{probeKrai ?? "—"}'."));
    }

    private static void ValidatePoints(List<CatalogIssue> issues, string path, List<ProbePoint> points, HashSet<string> pointIds)
    {
        for (var i = 0; i < points.Count; i++)
        {
            RequireSlug(issues, $"{path}[{i}].id", points[i].Id);
            RequireText(issues, $"{path}[{i}].text", points[i].Text);
            if (!pointIds.Add(points[i].Id))
            {
                issues.Add(CatalogIssue.Error($"{path}[{i}].id", $"Point id '{points[i].Id}' is used twice; point ids are unique across all probes."));
            }

            if (points[i].Level is { } level && !CatalogCodes.PointLevels.Contains(level))
            {
                issues.Add(CatalogIssue.Error($"{path}[{i}].level", $"Unknown level '{level}'; use one of {string.Join(", ", CatalogCodes.PointLevels)}."));
            }

            if (points[i].Competencies is { } competencies)
            {
                foreach (var competency in competencies) RequireSlug(issues, $"{path}[{i}].competencies", competency);
                CheckUnique(issues, $"{path}[{i}].competencies", competencies);
            }
        }
    }

    /// <summary>
    /// Lilejka opens a person's probes one after another by order, so two live probes of the same
    /// ulad, krai and edition may not share a place. Retired ones are out of the line already.
    /// </summary>
    private static void ValidateProbeOrders(List<CatalogIssue> issues, CatalogBundle bundle, CatalogBundle? reference)
    {
        static string Place(ProbeDefinition p) => $"{p.Ulad}|{p.Krai}|{p.Edition}|{p.Order}";

        var own = bundle.Probes.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        var taken = new Dictionary<string, ProbeDefinition>(StringComparer.Ordinal);
        foreach (var probe in (reference?.Probes ?? []).Where(p => !own.Contains(p.Id) && p.Status != CatalogCodes.StatusRetired))
        {
            taken[Place(probe)] = probe;
        }

        for (var i = 0; i < bundle.Probes.Count; i++)
        {
            var probe = bundle.Probes[i];
            if (probe.Status == CatalogCodes.StatusRetired) continue;
            if (!taken.TryAdd(Place(probe), probe))
            {
                issues.Add(CatalogIssue.Error($"probes[{i}].order", $"Probe {taken[Place(probe)].Id} already stands at {probe.Order} in this edition; give each probe its own place."));
            }
        }
    }

    private static void ValidateDegree(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        DegreeDefinition degree,
        string path,
        IReadOnlySet<string>? availableImages,
        CatalogBundle? reference)
    {
        RequireSlug(issues, path + ".id", degree.Id);
        RequireText(issues, path + ".title", degree.Title);
        if (degree.Family is not null) RequireSlug(issues, path + ".family", degree.Family);
        if (!CatalogCodes.Ulady.Contains(degree.Ulad)) issues.Add(CatalogIssue.Error(path + ".ulad", $"Unknown ulad '{degree.Ulad}'."));
        if (degree.Gender is not null && !CatalogCodes.Genders.Contains(degree.Gender))
        {
            issues.Add(CatalogIssue.Error(path + ".gender", $"Gender is one of {string.Join(", ", CatalogCodes.Genders)}, or left out."));
        }

        if (degree.Order < 0) issues.Add(CatalogIssue.Error(path + ".order", "Order is a whole number from 0."));
        foreach (var ulad in degree.WornIn)
        {
            if (!CatalogCodes.Ulady.Contains(ulad)) issues.Add(CatalogIssue.Error(path + ".wornIn", $"Unknown ulad '{ulad}'."));
            else if (ulad == degree.Ulad) issues.Add(CatalogIssue.Error(path + ".wornIn", $"The degree is granted in {ulad}; wornIn lists the other ulady."));
        }

        CheckUnique(issues, path + ".wornIn", degree.WornIn);
        ValidateKraiAndOwnership(issues, bundle, reference, path, degree.Krai, reference?.Degrees.FirstOrDefault(d => d.Id == degree.Id)?.Krai);
        ValidateStatus(issues, path, degree.Status);
        ValidateImages(issues, path, degree.Images, availableImages, required: true);
        ValidateRequirements(issues, path + ".requirements", degree.Requirements, required: false);
    }

    private static void ValidateAward(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        AwardDefinition award,
        string path,
        IReadOnlySet<string>? availableImages,
        CatalogBundle? reference)
    {
        RequireSlug(issues, path + ".id", award.Id);
        RequireSlug(issues, path + ".group", award.Group);
        RequireText(issues, path + ".title", award.Title);
        if (award.Ulad is not null && !CatalogCodes.Ulady.Contains(award.Ulad)) issues.Add(CatalogIssue.Error(path + ".ulad", $"Unknown ulad '{award.Ulad}'."));
        ValidateKraiAndOwnership(issues, bundle, reference, path, award.Krai, reference?.Awards.FirstOrDefault(a => a.Id == award.Id)?.Krai);
        ValidateStatus(issues, path, award.Status);
        ValidateImages(issues, path, award.Images, availableImages, required: true);
        ValidateRequirements(issues, path + ".requirements", award.Requirements, required: false);
    }

    private static void ValidateOverride(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        CatalogBundle? reference,
        CatalogOverride o,
        string path,
        HashSet<string> badgeIds,
        HashSet<string> probeIds,
        HashSet<string> degreeIds,
        HashSet<string> awardIds)
    {
        if (!IsKrai(o.Krai))
        {
            issues.Add(CatalogIssue.Error(path + ".krai", "Krai is a 2–3 letter lowercase code."));
            return;
        }

        if (reference is not null && bundle.Source?.Krai is { } sourceKrai && o.Krai != sourceKrai)
        {
            issues.Add(CatalogIssue.Error(path + ".krai", $"A bundle from krai '{sourceKrai}' may only carry its own overrides."));
        }

        var parts = o.Target.Split(':', 2);
        var known = parts.Length == 2 && parts[0] switch
        {
            CatalogCodes.TargetBadge => badgeIds.Contains(parts[1]),
            CatalogCodes.TargetProbe => probeIds.Contains(parts[1]),
            CatalogCodes.TargetDegree => degreeIds.Contains(parts[1]),
            CatalogCodes.TargetAward => awardIds.Contains(parts[1]),
            _ => false,
        };
        if (!known)
        {
            issues.Add(CatalogIssue.Error(path + ".target", $"Unknown target '{o.Target}'; use badge:<id>, probe:<id>, degree:<id> or award:<id>."));
            return;
        }

        var prefix = o.Krai + "-";
        foreach (var r in o.AddRequirements.Where(r => !r.Id.StartsWith(prefix, StringComparison.Ordinal)))
        {
            issues.Add(CatalogIssue.Error(path + ".addRequirements", $"Added requirement '{r.Id}' must start with '{prefix}'."));
        }

        foreach (var p in o.AddPoints.Where(p => !p.Id.StartsWith(prefix, StringComparison.Ordinal)))
        {
            issues.Add(CatalogIssue.Error(path + ".addPoints", $"Added point '{p.Id}' must start with '{prefix}'."));
        }

        if (parts[0] != CatalogCodes.TargetProbe && (o.AddPoints.Count > 0 || o.RemovePoints.Count > 0))
        {
            issues.Add(CatalogIssue.Error(path, "Points can only be added to or removed from a probe."));
        }

        if (parts[0] == CatalogCodes.TargetProbe)
        {
            var probe = bundle.Probes.FirstOrDefault(p => p.Id == parts[1]) ?? reference?.Probes.FirstOrDefault(p => p.Id == parts[1]);
            if (probe is not null)
            {
                var codes = probe.Sections.Select(s => s.Code).ToHashSet(StringComparer.Ordinal);
                foreach (var p in o.AddPoints.Where(p => !string.IsNullOrEmpty(p.Section) && !codes.Contains(p.Section!)))
                {
                    issues.Add(CatalogIssue.Error(path + ".addPoints", $"Probe {probe.Id} has no section '{p.Section}'."));
                }
            }
        }
    }

    private static void ValidateKraiAndOwnership(
        List<CatalogIssue> issues,
        CatalogBundle bundle,
        CatalogBundle? reference,
        string path,
        string? krai,
        string? existingKrai)
    {
        var effective = krai ?? bundle.Source?.Krai;
        if (effective is null)
        {
            issues.Add(CatalogIssue.Warning(path + ".krai", "Item names no krai and the bundle has no source.krai."));
        }
        else if (!IsKrai(effective))
        {
            issues.Add(CatalogIssue.Error(path + ".krai", "Krai is a 2–3 letter lowercase code: ua, pl, cz, de, ..."));
        }

        if (reference is not null && existingKrai is not null && effective is not null && existingKrai != effective)
        {
            issues.Add(CatalogIssue.Error(path + ".id", $"This id already belongs to krai '{existingKrai}'. Use an override to change it for '{effective}', or pick another id."));
        }
    }

    private static void ValidateStatus(List<CatalogIssue> issues, string path, string status)
    {
        if (!CatalogCodes.Statuses.Contains(status))
        {
            issues.Add(CatalogIssue.Error(path + ".status", $"Status is one of {string.Join(", ", CatalogCodes.Statuses)}."));
        }
    }

    private static void ValidateImages(List<CatalogIssue> issues, string path, ImageSet images, IReadOnlySet<string>? available, bool required)
    {
        if (images.Color is null && images.Bw is null)
        {
            if (required) issues.Add(CatalogIssue.Warning(path + ".images", "Item has no image."));
            return;
        }

        foreach (var (name, field) in new[] { (images.Color, "color"), (images.Bw, "bw") })
        {
            if (name is null) continue;
            if (!ImageSafety.IsValidFileName(name) || ImageSafety.ContentTypeOf(name) is null)
            {
                issues.Add(CatalogIssue.Error($"{path}.images.{field}", $"'{name}' is not a valid image file name."));
            }
            else if (available is not null && !available.Contains(name))
            {
                issues.Add(CatalogIssue.Error($"{path}.images.{field}", $"Image '{name}' is not in images/."));
            }
        }
    }

    private static void ValidateRequirements(List<CatalogIssue> issues, string path, List<Requirement> requirements, bool required)
    {
        if (required && requirements.Count == 0) issues.Add(CatalogIssue.Warning(path, "No requirements."));
        CheckUnique(issues, path, requirements.Select(r => r.Id));
        for (var i = 0; i < requirements.Count; i++)
        {
            RequireText(issues, $"{path}[{i}].id", requirements[i].Id);
            RequireText(issues, $"{path}[{i}].text", requirements[i].Text);
        }
    }

    internal static IEnumerable<ProbePoint> AllPoints(ProbeDefinition probe)
    {
        return probe.Points.Concat(probe.Sections.SelectMany(s => s.Points));
    }

    private static HashSet<string> Ids(IEnumerable<string> own, IEnumerable<string>? reference)
    {
        var set = own.ToHashSet(StringComparer.Ordinal);
        if (reference is not null) set.UnionWith(reference);
        return set;
    }

    private static void CheckUnique(List<CatalogIssue> issues, string path, IEnumerable<string> ids)
    {
        foreach (var dup in ids.GroupBy(id => id, StringComparer.Ordinal).Where(g => g.Count() > 1))
        {
            issues.Add(CatalogIssue.Error(path, $"Id '{dup.Key}' is used {dup.Count()} times."));
        }
    }

    private static void RequireSlug(List<CatalogIssue> issues, string path, string? value)
    {
        if (!IsSlug(value)) issues.Add(CatalogIssue.Error(path, $"'{value}' is not a slug (lowercase latin letters, digits and '-')."));
    }

    private static void RequireText(List<CatalogIssue> issues, string path, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) issues.Add(CatalogIssue.Error(path, "Required."));
    }
}
