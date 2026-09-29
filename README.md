# Wildfire Risk Reduction Viewer

An interactive map viewer sharing the results of **PIISA** (https://piisa-project.eu/)
an EU-funded project modelling wildfire risk reduction through fuel break
implementation in central Portugal.

🔗 **Live viewer:** https://lfcgalizia.github.io/wildfire-risk-viewer/

## About

The viewer lets you explore annual burn probability under seven fuel-break
scenarios, alongside the exposure layers (buildings and planted forest) and
the resulting estimated annual expected losses for each scenario.

### Scenarios

| Scenario | Description |
|---|---|
| Business as usual (BAU) | No fuel break intervention |
| Primary — full removal | Primary fuel breaks, full fuel removal |
| Primary — partial removal | Primary fuel breaks, partial fuel removal |
| Secondary — full removal | Secondary fuel breaks, full fuel removal |
| Secondary — partial removal | Secondary fuel breaks, partial fuel removal |
| Combined — full removal | Primary + secondary fuel breaks, full fuel removal |
| Combined — partial removal | Primary + secondary fuel breaks, partial fuel removal |

### Layers

- **Annual burn probability (BP)** — one raster per scenario above.
- **Fuel breaks** — vector network of modelled primary/secondary fuel breaks.
- **Exposure** — buildings and planted forest stands.
- **Risk / Annual Expected Loss (AEL)** — annual burn probability intersected with
  exposure value, per scenario, per feature.

## Risk calculation

We quantified wildfire risk in terms of annual expected economic losses combining fire hazard (annual burn probability) with the economic value for forest plantations and buildings at grid cell level. Annual burn probability was computed from stochastic fire simulations at 100m resolution.
Detailed of methods used in this analysis are presented in the article: 
                                           


## Repository structure
