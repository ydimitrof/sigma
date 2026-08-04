# Настройка на `preview` средата

Copy-paste runbook за еднократното конфигуриране на ephemeral PR preview-тата. За модела и
жизнения цикъл виж [`dev-environments.md`](dev-environments.md); за production/staging —
[`deploy.md`](deploy.md).

## 0. Предпоставки

Preview-тата ползват **вече провизионираните** dev ресурси в споделения Cloudflare акаунт — този
репозиторий не създава нищо ново:

| Ресурс | Име |
|---|---|
| Cloudflare акаунт | `b2abee0097d289c0762fd5b85a61353d` (Info@midt-crew.eu) |
| D1 | `sigma-dev` |
| R2 (CSV кеш) | `sigma-csv-cache-dev` |
| R2 (отчети на асистента) | `sigma-reports-dev` |
| Vectorize | `sigma-assistant-dev` |

Нужен е **scoped API token** за този акаунт със следните минимални права:

- Workers Scripts\:Edit — деплой и триене на preview worker-и, `wrangler secret put`
- D1\:Edit — binding-ът на базата
- Workers R2 Storage\:Edit — binding-ите на кофите
- Account Settings\:Read — резолвва акаунта

> Токенът дава право да се **трие** worker в споделен акаунт. Бариерите в
> `scripts/teardown-remote.mjs` са това, което ограничава триенето до preview-тата на *този*
> репозиторий — виж [`dev-environments.md`](dev-environments.md) §3.

## 1. GitHub Environment `preview`

*Settings → Environments → New environment → `preview`*.

> **Без required reviewers.** Всеки preview деплой минава през тази среда — одобрение би блокирало
> всеки push към всеки отворен PR.

```bash
gh api --method PUT repos/ydimitrof/sigma/environments/preview
```

### Secrets

| Secret | Стойност |
|---|---|
| `CLOUDFLARE_API_TOKEN` | scoped token от раздел 0 |
| `CLOUDFLARE_ACCOUNT_ID` | `b2abee0097d289c0762fd5b85a61353d` |
| `SIGMA_D1_ID` | `database_id` на `sigma-dev` |
| `BGGPT_API_KEY` | **опционален** — виж по-долу |

```bash
gh secret set CLOUDFLARE_API_TOKEN  --env preview --repo ydimitrof/sigma
gh secret set CLOUDFLARE_ACCOUNT_ID --env preview --repo ydimitrof/sigma
gh secret set SIGMA_D1_ID           --env preview --repo ydimitrof/sigma
```

`BGGPT_API_KEY` е ключът на доставчика на AI асистента. Secret-ите са **per-worker-script**, затова
ефемерният worker НЕ наследява ключа — `preview.yml` го `wrangler secret put`-ва след деплоя. Ако не е
зададен, деплоят минава, но `/assistant/chat` връща контролирано **503** (preview само с UI).

### Variables

| Variable | Стойност |
|---|---|
| `SIGMA_D1_NAME` | `sigma-dev` |
| `SIGMA_CSV_CACHE_NAME` | `sigma-csv-cache-dev` |
| `SIGMA_REPORTS_NAME` | `sigma-reports-dev` |
| `SIGMA_VECTORIZE_NAME` | `sigma-assistant-dev` |

```bash
gh variable set SIGMA_D1_NAME        --env preview --repo ydimitrof/sigma --body sigma-dev
gh variable set SIGMA_CSV_CACHE_NAME --env preview --repo ydimitrof/sigma --body sigma-csv-cache-dev
gh variable set SIGMA_REPORTS_NAME   --env preview --repo ydimitrof/sigma --body sigma-reports-dev
gh variable set SIGMA_VECTORIZE_NAME --env preview --repo ydimitrof/sigma --body sigma-assistant-dev
```

> **Не задавайте `SIGMA_WEB_NAME`.** Workflow-ът го изчислява от притежателя на репозиторя и номера
> на PR-а (`scripts/preview-name.mjs`). Ръчна стойност би дала едно и също име за всеки PR — тоест
> всеки нов preview би презаписвал предишния.

> Guard-ът в `preview.yml` отказва деплой, ако някое от `SIGMA_D1_NAME` / `SIGMA_CSV_CACHE_NAME` /
> `SIGMA_REPORTS_NAME` / `SIGMA_VECTORIZE_NAME` съвпада с production default-а — за да не може
> сгрешена среда да насочи preview-тата към живите данни.

### Опционално: `PREVIEW_WORKER_PREFIX`

Repository-level variable (не в средата). Задава се само за **по-къс URL**; без нея името се извежда
автоматично и е вече уникално за репозиторя. Стойността замества **целия** изведен префикс — worker-ът
е `<префикс>-<номер на PR>`.

```bash
gh variable set PREVIEW_WORKER_PREFIX --repo ydimitrof/sigma --body sigma-yo-pr   # → sigma-yo-pr-12
```

Стойността трябва да е валиден DNS label (малки букви, цифри, вътрешни тирета) — иначе workflow-ът
спира с грешка, вместо да я пренапише мълчаливо.

## 2. Проверка

Без Cloudflare достъп — само изведеното име и предпазните бариери:

```bash
GITHUB_REPOSITORY_OWNER=ydimitrof node scripts/preview-name.mjs --pr 12
# → PREVIEW_WORKER_PREFIX=sigma-ydimitrof-pr
# → SIGMA_WEB_NAME=sigma-ydimitrof-pr-12

# Чуждите preview-та и дълготрайните worker-и трябва да бъдат ОТКАЗАНИ:
GITHUB_REPOSITORY_OWNER=ydimitrof node scripts/teardown-remote.mjs --name sigma-pr-12 --dry-run
GITHUB_REPOSITORY_OWNER=ydimitrof node scripts/teardown-remote.mjs --name sigma --dry-run

pnpm test:scripts
```

С достъп до акаунта — dry run на reaper-а (нищо не се трие без `--apply`):

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=b2abee0097d289c0762fd5b85a61353d \
GITHUB_REPOSITORY_OWNER=ydimitrof \
  node scripts/reap-previews.mjs
```

Изходът отпечатва колко worker-а има в акаунта и колко от тях съвпадат с `sigma-ydimitrof-pr-<номер>`.
Второто число трябва да включва **само** preview-тата на този репозиторий.

Накрая: отвори тестов PR и провери, че се появява коментар с URL, че повторен push обновява същия
коментар (а не добавя нов), и че при затваряне worker-ът се трие.
