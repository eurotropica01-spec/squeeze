# $SQUEEZE — Mechanism Spec v0.1

**The borrow desk and short interest tape for Robinhood Chain.**

Chain: Robinhood Chain (Arbitrum Orbit L2, chainId 4663, ETH gas, ~100ms blocks)
Venue: Pons token pools — Uniswap **V3**, 1% fee tier, TOKEN/WETH, LP locked at creation

---

## 1. The gap

Pons heeft 50.000+ tokens gelanceerd. Elk van die markten is **long-only**. Je kunt geen bearish view uitdrukken, er is geen borrow-markt voor memecoins, en het krachtigste narratief-primitief uit de retail-handel — **short interest** — bestaat nergens on-chain.

Twee producten, één protocol:

| | Wat | Voor wie |
|---|---|---|
| **The Desk** | Overgecollateraliseerd tokens lenen om te shorten | ~5% van de gebruikers |
| **The Tape** | Publieke, live short interest per token | ~95% van de gebruikers |

The Desk verdient het geld. **The Tape is de moat** — het is de reden dat mensen dagelijks terugkomen, en het is content die zichzelf produceert.

---

## 2. Waarom shorten van memecoins normaal stukloopt

Vier redenen, en de tegenmaatregel per stuk. Dit is het hele ontwerp.

### 2.1 Er zijn geen lenders
Niemand leent zijn bag uit om jou te laten shorten.

**Oplossing: betaal ze in ETH, niet in tokens.** Borrow-rente wordt in ETH uitgekeerd. Een houder van een stervend token krijgt echte yield op een zak die hij toch niet kwijtraakt. Bij hoge utilization loopt dat op tot 300%+ APR. De vraag naar shorten *is* het rendement voor houders — dat is de flywheel.

### 2.2 Ondiepe pools → oracle-manipulatie
Eén whale pompt de pool en liquideert elke short.

**Oplossing: drie lagen.**
- 30-minuten TWAP uit de Uniswap V3-pool als primaire prijs — zie §5, dit is native beschikbaar.
- **Dual-bound liquidatie**: een positie is pas liquideerbaar als *zowel* de 30-min TWAP *als* de 5-min TWAP de drempel breken. Eén-blok-pumps doen niets.
- **Manipulation cost floor**: een token is alleen listable als het duurder is om de prijs +50% te bewegen dan de totale collateral die in die markt op het spel staat. Berekend uit pool-reserves, herijkt bij elke verhoging van de borrow cap.

Pons lockt de LP al bij het aanmaken van de launch, via lockercontract `0x736D76699C26D0d966744cAe304C000d471f7F35`. Graduatie (drempel 4.2 ETH) verplaatst niets — het is dezelfde pool voor en na. De liquiditeit waar je in short kan dus niet onder de markt vandaan getrokken worden.

### 2.3 Onbegrensd verlies
Een short kan in theorie oneindig verliezen.

**Oplossing:** overgecollateraliseerd, harde liquidatie, verlies begrensd tot de collateral van de positie. Geen cross-margin in v1.

### 2.4 Het token rugt naar nul
Wat gebeurt er met de lender?

Niets ergs. De lender leent TOKEN uit en krijgt TOKEN terug. Gaat het token naar nul, dan koopt de shorter voor stof terug en levert hij de tokens netjes af. In *token*-termen is de lender heel; in ETH-termen was hij sowieso al nul. De lender houdt bovendien de ETH-rente. **Lenders zijn structureel beschermd tegen precies het scenario waar ze het bangst voor zijn.** Dat is de pitch.

---

## 3. The Desk — contractmechaniek

### 3.1 Lenen (supply)

```
deposit(token, amount) -> sToken
withdraw(sToken, amount) -> token
claim() -> ETH
```

- Houder stort TOKEN in de per-token vault, ontvangt `sTOKEN` als receipt (ERC-20, verhandelbaar).
- Rente accrued in **ETH**, claimbaar los van het principal.
- Withdraw is beperkt tot de vrije (niet-uitgeleende) balans. Bij 100% utilization moet je wachten tot een short sluit — standaard, en precies wat de rente omhoog jaagt.

### 3.2 Rentecurve (utilization-based)

```
U = borrowed / totalSupplied

U <= U_kink (80%):   APR = 20% + U * (80% / U_kink)
U >  U_kink:         APR = 100% + (U - U_kink) * (400% / (1 - U_kink))
```

Bij 80% utilization → 100% APR. Bij 95% → 400% APR. Bij 100% → 500% APR cap.
Steile curve boven de kink is bewust: dat dwingt shorts te sluiten voordat de vault droogvalt.

### 3.3 Shorten (borrow)

```
openShort(token, borrowAmount, collateralETH) -> positionId
closeShort(positionId)
addCollateral(positionId, amountETH)
```

Flow in één transactie:
1. Trader stort ETH collateral (minimaal **150%** van de notional).
2. Protocol leent TOKEN uit de vault.
3. Protocol verkoopt die TOKEN direct in de Uniswap V3-pool (1% fee tier).
4. Opbrengst (ETH) blijft in de positie als extra collateral.

Positie = `{ debt: X TOKEN, collateral: Y ETH, accrued: Z ETH }`

```
healthFactor = collateral / (debt * TWAP * liquidationThreshold)
liquidationThreshold = 1.20   // liquidatie bij 120% collateral ratio
```

Sluiten: koop TOKEN terug uit de pool, los de debt af, rest gaat terug naar de trader.

### 3.4 Liquidatie

Bij `HF < 1` **en** bevestiging door beide TWAP-vensters:
- Keeper koopt TOKEN, lost debt af, incasseert **8% bonus** uit de collateral.
- Restant naar de trader.
- Blijft er bad debt over → Backstop Fund. Is die leeg → gesocialiseerd verlies naar lenders van die specifieke vault, niet protocol-breed.

**Dit staat expliciet in de docs. Verzwijgen is hoe je je reputatie sloopt.**

### 3.5 Rente en collateral

Rente wordt per blok in ETH afgeboekt van de collateral van de positie. Vreet de rente de collateral op tot onder de drempel, dan wordt de positie geliquideerd zoals elke andere. Shorten is nooit gratis wachten.

---

## 4. Listing criteria

Een token komt op The Desk als het aan **alles** voldoet:

| # | Criterium | Waarom |
|---|---|---|
| 1 | Gegradueerd op Pons (≥ 4.2 ETH bereikt), LP locked | LP kan niet gepulled worden |
| 2 | ≥ 30 ETH pool-liquiditeit | Terugkopen moet mogelijk zijn — ruim boven de graduatiedrempel |
| 3 | ≥ 500 holders | Anders is de "markt" drie wallets |
| 4 | ≥ 72u sinds graduatie | Geen verse launches |
| 5 | Manipulation cost floor gehaald | §2.2 |
| 6 | Observation cardinality opgehoogd | §5 — zonder dit bestaat de TWAP niet |

**Borrow cap per token:**
```
cap = min( 20% van circulating supply, k * sqrt(poolLiquidityETH) )
```
De sqrt-term zorgt dat de cap sublineair meegroeit met de liquiditeit — bij dunne pools blijft de markt klein, ook als de mcap hoog is.

v1: gecureerd door het team. v2: permissionless met automatische caps. Dat eerlijk zeggen, niet doen alsof v1 al trustless is.

---

## 5. De oracle — waarom dit überhaupt kan

Het hele protocol staat of valt bij één vraag: **bestaat er een manipulatiebestendige prijs voor een memecoin-pool?** Het antwoord is ja, en de reden is een gelukkig toeval.

### 5.1 Pons zit op V3, en dat is hier beter dan V4

Uniswap **V4 heeft geen ingebouwde oracle** — die functionaliteit is eruit gehaald en naar optionele hooks verplaatst. Was Pons naar V4-pools gegradueerd, dan had er zonder oracle-hook simpelweg geen on-chain prijsgeschiedenis bestaan en had SQUEEZE zijn eigen checkpoint-infrastructuur moeten bouwen.

Pons draait op **Uniswap V3**. Elke launch krijgt een eigen TOKEN/WETH-pool op het 1%-fee tier, en V3 heeft de TWAP-oracle *in de pool zelf* zitten. Voor deze use case is de oudere versie strikt beter.

### 5.2 Hoe de prijs eruit komt

Elke V3-pool houdt een ringbuffer van observations bij: `(blockTimestamp, tickCumulative, secondsPerLiquidityCumulative)`. Je leest hem niet direct uit maar via `observe()`:

```solidity
uint32[] memory ago = new uint32[](2);
ago[0] = 1800;  // 30 minuten geleden
ago[1] = 0;     // nu

(int56[] memory tickCumulatives, ) = pool.observe(ago);

int24 avgTick = int24((tickCumulatives[1] - tickCumulatives[0]) / 1800);
// prijs = 1.0001^avgTick
```

Twee eigenschappen die dit bruikbaar maken:

- **Counterfactual observations.** Valt jouw venster niet precies op een blok waarin een observation is geschreven, dan interpoleert de pool er zelf een. Je hebt dus geen observation op exact t−1800s nodig.
- **Geometrisch gemiddelde.** Het gemiddelde van de *tick* nemen komt neer op een geometrisch gemiddelde van de prijs. Dat is minder gevoelig voor uitschieters dan een rekenkundig gemiddelde — precies wat je wilt tegen een pumper.

Beide vensters uit §2.2 (30 min en 5 min) komen uit dezelfde call. De dual-bound check kost je één extra array-element, geen extra infrastructuur.

### 5.3 De valkuil: cardinality

Een verse V3-pool bewaart **één** observation en overschrijft die elk blok. Op zo'n pool geeft `observe(1800)` gewoon een revert — de geschiedenis bestaat niet.

Iedereen mag dat ophogen, permissionless, tot maximaal 65535:

```solidity
pool.increaseObservationCardinalityNext(2048);
```

Dat is dus een **verplichte stap in het listingproces** (criterium 6 in §4), en SQUEEZE betaalt hem.

Hoe groot? De buffer moet genoeg blokken-met-een-swap overspannen om 1800 seconden te dekken. Robinhood Chain heeft **~100ms blokken**, dus in het slechtste geval 18.000 blokken per venster — maar er wordt alleen een observation geschreven in blokken waarin daadwerkelijk geswapt wordt:

| Activiteit | Swaps in 30 min | Benodigde cardinality |
|---|---|---|
| Rustig | ~300 | 512 |
| Actief | ~1.500 | 2048 |
| Squeeze Watch | ~6.000 | 8192 |

**2048 als standaard, 8192 voor de heetste markten.** Elke slot kost een cold SSTORE (~20k gas) op het moment van de call, dus 2048 slots ≈ 41M gas — op een L2 betaalbaar, maar wel te verdelen over meerdere transacties omdat het niet in één blok past.

En: na het ophogen is het venster **niet meteen bruikbaar**. De pool moet eerst 30 minuten aan observations opbouwen. Dat is de echte reden achter het "≥72u sinds graduatie"-criterium — die wachttijd deed je toch al.

### 5.4 Wat 100ms-blokken veranderen

Snelle blokken zijn de belangrijkste reden dat een leenmarkt voor memecoins op Robinhood Chain haalbaar is en op Ethereum L1 niet. Bad debt ontstaat in het gat tussen "health factor breekt" en "keeper heeft gesloten". Op L1 is dat gat 12 seconden plus een gasveiling; hier is het honderden milliseconden.

Daar komt bij dat de sequencer **first-come-first-served** ordent zonder priority fees. Er is dus geen gasveiling om liquidaties: keepers concurreren op latency in plaats van op steekpenningen, en de 8% bonus komt grotendeels bij de keeper terecht in plaats van bij een builder.

De keerzijde, eerlijk: het is één sequencer, en L2-reorgs zijn mogelijk tot een batch op Ethereum staat (~13 minuten). Voor de protocolstate maakt dat niets uit — die is intern consistent — maar off-chain keepers en de UI mogen een sequencer-receipt niet als finaal behandelen.

### 5.5 Er zit niets nieuws in

Dit is het echte antwoord op "hoe is dit mogelijk": **er hoeft niets uitgevonden te worden.**

- De leenkant is Aave/Compound-logica: een utilization-curve, een health factor, een liquidatiebonus.
- De prijskant is een standaard V3 TWAP-read.
- De executiekant is een gewone `exactInputSingle` swap.
- Het collateral is ETH; de tokens zijn gewone ERC-20's met vaste supply.

Geen nieuwe cryptografie, geen nieuw AMM-primitief, geen hook. De vernieuwing zit in de *toepassing* — een leenmarkt richten op launchpad-tokens en de resulterende short interest publiceren — niet in de machinerie. Dat is een sterkte: het is in weken te bouwen en te auditen tegen patronen die al honderden miljarden aan volume hebben overleefd.

---

## 6. The Tape

Per token, live berekend:

| Metric | Formule |
|---|---|
| **Short Interest %** | `borrowed / circulatingSupply` |
| **Days to Cover** | `borrowed / avgDailyVolume` |
| **Borrow APR** | uit de rentecurve — de prijs van angst |
| **Utilization** | `borrowed / totalSupplied` |
| **Squeeze Score** | zie hieronder |

### Squeeze Score (0–100)

```
score = 40 * norm(shortInterestPct, 0, 25)
      + 25 * norm(daysToCover,     0, 10)
      + 20 * norm(utilization,     0, 1)
      + 15 * norm(borrowAPR,       0, 300)

norm(x, lo, hi) = clamp((x - lo) / (hi - lo), 0, 1)
```

Boven **80** krijgt een token het **SQUEEZE WATCH**-label: bovenaan de site, en er vuurt automatisch een X-post af.

Dit is het hele marketingapparaat. Eén deelbaar getal, een drempel die vanzelf events genereert, en een reden om elke dag te kijken. Je hoeft nooit meer een "announcement" te verzinnen — de data produceert ze.

### The Feed

Elke liquidatie wordt publiek gepost: `$XYZ short liquidated — 4.2 ETH · HF 0.97`.
Liquidatiecascades zijn het meest gedeelde materiaal in crypto. Dit protocol **bezit de feed**.

---

## 7. $SQUEEZE token

Fixed supply, gelanceerd op Pons zelf. Geen presale, geen VC-allocatie — dat past niet bij het publiek en het is op deze chain aantoonbaar niet nodig.

**Fees:** 10% van alle borrow-rente gaat naar het protocol.

**Verdeling van protocolomzet:**
- **80% → buyback & burn.** Exact het model waarmee PONS zelf 15x deed op deze chain. Je verzint geen nieuw tokenmodel; je kopieert het bewezen model en laat zien dat je snapt wat hier werkt.
- **20% → Backstop Fund.** Dekt bad debt uit mislukte liquidaties.

**Staking:**
- Verlaagt je borrow-rate in tiers (5/10/15% korting).
- Vroege toegang tot nieuwe listings.

Geen governance-theater. Twee concrete voordelen, allebei direct in euro's uit te drukken.

---

## 8. Roadmap

### v0 — The Tape, pre-desk (week 1–2)
Short interest bestáát nog niet zolang er geen borrow-markt is. Dus publiceer eerst een **Squeeze Setup Score** op proxy-data die je vandaag al kunt berekenen:

- holder-concentratie (top 10 als % van supply)
- LP-diepte t.o.v. mcap
- netto sell pressure laatste 24u
- afstand tot ATH
- ontwaakte dormant whale-wallets

Framing: dit is een **pre-squeeze screener**, geen short interest. Dat verschil expliciet benoemen. Levert je een publiek en een merk vóór er één contract live staat.

### v1 — The Desk (week 3–6)
5 gecureerde tokens, ETH als collateral, echte short interest vervangt de proxies.

### v2 — Permissionless listings (maand 2–3)
Automatische caps op basis van de manipulation cost floor.

### v3 — Perps (of niet)
De borrow desk is verdedigbaarder en heeft minder concurrentie dan perps. Perps zijn een keuze, geen verplichting.

---

## 9. Contractarchitectuur

```
SqueezeCore.sol          — posities, health factors, liquidatie
SqueezeVault.sol         — per-token lending vault, ERC-20 sToken receipts
InterestRateModel.sol    — utilization curve, pure functions
SqueezeOracle.sol        — dual-window TWAP via pool.observe(), manipulation cost floor
ListingRegistry.sol      — listing criteria, borrow caps, curatie
BackstopFund.sol         — bad debt buffer
FeeRouter.sol            — 80% buyback&burn / 20% backstop
SqueezeToken.sol         — fixed supply ERC-20
SqueezeStaking.sol       — rate tiers
```

Executie loopt via de bestaande Uniswap V3-pools van Pons — **geen eigen pool, geen hook, geen migratie**. SQUEEZE raakt de pool alleen aan met `observe()` (lezen) en `exactInputSingle` (swappen). Elke gegradueerde Pons-token is daarmee bruikbaar zoals hij is, zonder medewerking van het Pons-team of van de dev van het token.

Dat laatste is belangrijk: **er is geen integratie nodig en niemand kan je de toegang ontzeggen.** Dat is precies wat je wilt bij een product dat sommige token-teams liever niet zouden zien bestaan.

---

## 10. Wat er mis kan gaan

Eerlijk, want dit hoort in de docs en op de site.

| Risico | Impact | Mitigatie |
|---|---|---|
| **Verticale pump op een dunne pool** | Bad debt — dit is verreweg de meest waarschijnlijke doodsoorzaak | Conservatieve caps, 150% initial margin, backstop fund, sqrt-scaling |
| **Geen supply in de vaults** | Geen product | Seed eerste vaults met treasury; richt op stervende tokens waar houders wanhopig yield willen |
| **Oracle-aanval** | Onterechte liquidaties | Dual-window TWAP, manipulation cost floor |
| **Communities keren zich tegen je** | Reputatie, gecoördineerde squeezes tegen jouw gebruikers | Deels onvermijdelijk — en deels gratis marketing. Neutraal blijven: het protocol kiest geen kant |
| **Regulatoir** | Shorten + retail | Non-custodial, geen US-entiteit, geen fiat-rails |

De grootste is de eerste. Elke parameterkeuze in dit document bestaat om die te overleven.

---

## 11. Waarom nu

- Robinhood Chain live sinds 1 juli 2026, $312M TVL, $600M dagelijks DEX-volume.
- Pons: 50.000+ launches, dominante launchpad, elke token in een eigen locked Uniswap V3-pool — mét native TWAP-oracle.
- Alles op die chain is long-only.
- De doelgroep is letterlijk de GME-cohort. **Short interest is voor hen geen abstract getal — het is het verhaal waar ze door radicaliseerden.**

Niemand van de ~35 projecten in het ecosysteem raakt deze lane aan.
