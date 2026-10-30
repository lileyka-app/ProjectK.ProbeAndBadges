# ProjectK.ProbeAndBadges

Вмілості, проби, ступені й відзначення Пласту для Лілейки: .NET-бібліотека, каталог даних і сервіс, який цей
каталог роздає.

Публічний каталог і документація API: https://catalog.lileyka.app/docs

## Що де лежить

| Тека | Що там |
|---|---|
| `src/ProjectK.ProbeAndBadges*` | бібліотека, яку підключає Лілейка (NuGet у GitHub Packages) |
| `src/ProjectK.Catalog` | модель каталогу v2 і перевірка записів |
| `catalog/` | сам каталог: `catalog.json` і зображення |
| `worker/` | сервіс каталогу на Cloudflare Workers: API, публічна сторінка, адмінка |
| `tools/ProjectK.Catalog.Cli` | конвертація зі старого формату, перевірка й пакування zip |
| `samples/` | демо для бібліотеки і приклад zip від краю |
| `tests/` | тести бібліотеки й каталогу |

## Бібліотека

Потрібен .NET 10.

```csharp
using ProjectK.ProbeAndBadges.DependencyInjection;

builder.Services.AddProbeAndBadgesApi();
```

```csharp
using ProjectK.ProbeAndBadges.Abstractions;

var badges = app.Services.GetRequiredService<IBadgesCatalog>();
var one = badges.GetById("avtoznavstvo-i");
var found = badges.Query(new BadgeQuery(Text: "актор", Country: "Україна"));

var probes = app.Services.GetRequiredService<IProbesCatalog>();
var sections = probes.GetSectionsByProbeId("probe-1");
```

Звідки брати дані, задає `options.DataSource`:

- `Auto` бере останній реліз PlastBadgesParser, а якщо не вдалося, то вбудований seed;
- `EmbeddedSeed` бере вбудований seed;
- `JsonFile`, `ReleaseDataZip` і `ReleaseDataZipUrl` беруть файл, zip або zip за адресою.

Якщо ввімкнено `EnableAssetsExtraction`, зображення з zip розпаковуються на диск. Шлях до них дає
`IBadgesAssetsStore.AssetsDirectoryPath`, і хост може віддавати їх як статичні файли.

Демо:

```bash
dotnet run --project samples/ProjectK.ProbeAndBadges.AspNetDemo
dotnet run --project samples/ProjectK.ProbeAndBadges.ConsoleDemo
```

Пакет публікується з тегу `v*`, див. `.github/workflows/publish-package.yml`.

## Сервіс каталогу

TypeScript, Hono, D1 для записів, R2 для зображень, Cloudflare Access для входу в адмінку.

```bash
cd worker
npm install
printf 'ENVIRONMENT=dev\nDEV_ACCESS_EMAIL=you@example.com\n' > .dev.vars
npm run db:migrate:local
node scripts/seed.mjs --local
npm run dev        # http://localhost:8787, адмінка на /admin/
npm test
```

У PowerShell `.dev.vars` створюється так:
`Set-Content .dev.vars "ENVIRONMENT=dev`nDEV_ACCESS_EMAIL=you@example.com" -Encoding ascii`.

З `ENVIRONMENT=dev` Worker не перевіряє Access і вважає тебе користувачем з `DEV_ACCESS_EMAIL`. Щоб
мати всі права, впиши ту саму адресу в `OWNER_EMAILS` у `wrangler.jsonc`.

`seed.mjs` заливає `catalog/` в базу і бакет. Він потрібен один раз на порожній базі, далі все
змінюється через адмінку.

## Каталог і CLI

`catalog/` збирається зі старого формату парсера:

```bash
scripts/convert-v1.sh ../PlastBadgesParser
```

Перевірити zip від краю перед завантаженням:

```bash
dotnet run --project tools/ProjectK.Catalog.Cli -- validate prague.zip --against catalog
```

Сервіс проганяє ті самі перевірки при кожному записі. Правила однакові в C# (`src/ProjectK.Catalog`)
і в TypeScript (`worker/src/validate.ts`). Якщо міняєш одне, міняй і друге.

Id вмілостей і точок проби не змінюються ніколи: за ними Лілейка зберігає, хто що здобув.

## Тести

```bash
dotnet test ProjectK.ProbeAndBadges.slnx
cd worker && npm run typecheck && npm test
```
