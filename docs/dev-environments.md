# Ephemeral PR preview среди

Този документ описва как работят **ephemeral preview средите за всеки PR**. Допълва
[`deploy.md`](deploy.md) (production / staging) — прочетете първо него за модела на средите и за
rendering механизма (`scripts/wrangler-render.mjs`).

Целта: **лесно да виждаме всеки PR на живо**, без да преправяме код и без да зареждаме данни наново
за всяка среда.

## Накратко

| | staging / production | PR preview (ephemeral) |
|---|---|---|
| Кога | merge в `main` / таг `v*` | автоматично, за всеки отворен PR |
| Worker-и | `sigma` + `sigma-etl` (и `-stage`) | само `sigma-<owner>-pr-<номер>` (web; **без ETL**) |
| URL | `sigma.midt.bg` / `sigma-stage.<subdomain>.workers.dev` | `sigma-<owner>-pr-<номер>.<subdomain>.workers.dev` |
| D1 | собствена база на средата | **споделя** dev базата (read-only от worker-а) |
| Данни | пълен корпус; cron-ът поддържа свежи | наследени от dev — без зареждане per-PR |
| Workflow | `.github/workflows/deploy.yml` | `.github/workflows/preview.yml` |
| GitHub Environment | `staging` / `production` | `preview` |
| Cloudflare Access | да | **не** (`*.workers.dev` е незащитен) |
| Премахване | дълготрайни (не се трият) | при затваряне на PR-а + reaper след 5 дни |

Защо preview-тата споделят dev базата: D1 няма евтин clone/snapshot, а пълно зареждане отнема ~20 мин
и ~1.4 GB. Затова за PR преглед е безсмислено да зареждаме данни наново — web worker-ът само **чете**,
така че всички preview-та сочат към **същата** dev D1 (`SIGMA_D1_ID` на `preview` средата = id-то на
dev базата). ETL worker-ът **пише** в D1 и е cron-only — затова **не** пускаме негово per-PR копие.

---

## 1. Имената са уникални за всеки репозиторий

Този репозиторий (`ydimitrof/sigma`), `lyubomir-bozhinov/sigma` и upstream `midt-bg/sigma` са
fork-ове на един проект и деплойват preview-тата си в **един и същ Cloudflare акаунт**. Схема от вида
`sigma-pr-<номер>` затова се сблъсква: PR #12 тук и PR #12 в другия fork дават **едно и също име** —
вторият деплой мълчаливо презаписва първия, а reaper-ът на всеки репозиторий трие worker-ите на
другия.

Решението: името носи **притежателя на репозиторя**, изведен автоматично, а не конфигуриран.

```
префикс = "sigma-" + <owner, lowercase> + "-pr"
worker  = <префикс>-<номер на PR>

ydimitrof/sigma          PR #12 → sigma-ydimitrof-pr-12
lyubomir-bozhinov/sigma  PR #12 → sigma-lyubomir-bozhinov-pr-12
midt-bg/sigma            PR #12 → sigma-midt-bg-pr-12
```

`scripts/preview-name.mjs` е **единственият** източник на това име. Deploy-ът, teardown-ът и reaper-ът
го внасят оттам, вместо всеки да носи собствено копие на шаблона — три копия на един regex е точно
начинът, по който преименувано preview остава завинаги неизтрито.

Три следствия, които правят схемата безопасна:

- **Няма какво да се забрави.** Изведено, не конфигурирано: променлива с fallback към общ default
  връща същия сблъсък при първия, който забрави да я зададе.
- **Reaper-ът е сляп за чуждите preview-та.** `scripts/reap-previews.mjs` изброява **всички** worker-и
  в акаунта, но обработва само тези, които съвпадат с `<префикс>-<цифри>` за *този* репозиторий.
- **Заблуден worker се разпознава.** По името се вижда от кой fork е дошъл.

`PREVIEW_WORKER_PREFIX` (GitHub *variable*) остава като **изричен override** за по-къс URL. Ако е
зададен, той се валидира, а не се пренаписва мълчаливо — деплой и teardown трябва да четат едно и също.

> Ограничението за дължина е DNS label-ът в `<име>.<subdomain>.workers.dev` — 63 символа. GitHub
> login-ите са най-много 39 символа, така че изведеното име стига до 54 в най-лошия случай.
> `previewWorkerName` проверява това и спира деплоя, вместо да произведе недостижим хост.

---

## 2. Жизнен цикъл

`.github/workflows/preview.yml` се задейства на `pull_request` (`opened`, `synchronize`, `reopened`,
`closed`).

- **При отваряне/push** → деплойва `sigma-<owner>-pr-<номер>` (само web), сочещ към споделената dev
  D1, и публикува/обновява коментар в PR-а с URL-а.
- **При затваряне** → трие worker-а със `scripts/teardown-remote.mjs` (споделените dev D1/R2 **не** се
  пипат — скриптът отказва защитените дълготрайни имена).
- **Авто-почистване (reaper)** → `.github/workflows/preview-reap.yml` се пуска по график (03:17 UTC) и
  трие всеки preview, стоял **5 дни** без нов деплой (`PREVIEW_MAX_AGE_DAYS`). Хваща два случая, които
  teardown-ът при затваряне изпуска: idle, но още отворени PR preview-та, и orphan-и, чийто teardown е
  пропаднал. Нов push към PR-а ре-деплойва preview-то.

Поведение:

- **Само същият репозиторий.** PR-и от fork нямат достъп до secrets, затова preview job-овете се
  пропускат за fork-ове (fork PR-ите пак минават обикновеното CI от `ci.yml`).
- **Concurrency** per PR с `cancel-in-progress` — бърза поредица от push-ове не трупа деплои. Teardown-ът
  е в **собствена** група без cancel: състезаващ се деплой не бива да го отмени и да остави orphan.
- **Без ETL, без данни per-PR** — preview-то показва същите данни като dev.
- **Без миграции.** `deploy.yml` прилага схемни промени към staging/production; preview потокът не
  изпълнява миграции — виж [раздел 4](#4-когато-pr-ът-пипа-миграциисхема).

## 3. Защитни бариери при триене

`scripts/teardown-remote.mjs` е единственият път, по който CI трие worker. Три бариери:

1. **Allowlist** — трие се само име, съвпадащо с `<префикс>-<цифри>` за този репозиторий. Задължителните
   завършващи цифри са това, което пази `sigma`, `sigma-etl` и подобните от съвпадение при какъвто и да
   е префикс.
2. **Denylist** — изричен списък от дълготрайни имена (`sigma`, `sigma-etl`, `sigma-stage`,
   `sigma-etl-stage`, `sigma-dev`, `sigma-etl-dev`), отхвърляни независимо от allowlist-а.
3. **Без префикс — без работа.** Ако нито `GITHUB_REPOSITORY_OWNER`, нито `PREVIEW_WORKER_PREFIX` са
   налични, скриптът спира с грешка, вместо да предположи общ default.

Провал на `wrangler delete`, различен от „вече не съществува" (код 10007), **не** се преглъща — иначе
изтекъл worker остава незабелязан.

## 4. Когато PR-ът пипа миграции/схема

Preview-то споделя dev базата, затова PR с **нова миграция** не бива да я прилага върху споделената
dev D1 от preview потока. За такива PR-и: прегледай схемната промяна първо локално (`pnpm setup` +
миграции), или провизионирай отделна еднократна D1. Автоматизиран per-PR изолиран D1 (с lightweight
seed) е възможно разширение — не е включено тук, за да останат preview-тата без разходи.

---

## Ограничения и разходи

Уникалните имена изолират **worker-а**. Следното остава споделено — важно е да се знае:

- **D1 няма clone/fork/snapshot.** Споделянето на dev базата е умишлено — алтернативата (пълен корпус
  per PR, ~20 мин) е скъпа и бавна. Същото важи за R2 кофите и Vectorize индекса на асистента.
- **Rate-limit namespace-ите** (`1001`–`1005` в `apps/web/wrangler.jsonc`) са **account-scoped целочислени
  id-та** и се споделят от всяко preview на всеки fork в акаунта — тоест квотите са общи. Приемливо за
  preview; при нужда от изолация се параметризират.
- **Cloudflare Access** се конфигурира извън кода (Zero Trust dashboard) и **не** се прилага за
  `*.workers.dev` preview URL-и — те са публични; не пускайте чувствително съдържание там.
- **Изисква Workers Paid plan** (Workflows + размера на D1).
- **Почистване**: при затваряне на PR worker-ът се трие автоматично, а reaper-ът трие idle preview-та
  след 5 дни без деплой (`PREVIEW_MAX_AGE_DAYS`).

Настройката на средата е в [`dev-environments-setup.md`](dev-environments-setup.md).
