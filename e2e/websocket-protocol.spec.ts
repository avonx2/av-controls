import { expect, test, type Browser, type Page } from '@playwright/test'

const fixtureBaseUrl = 'http://127.0.0.1:18173'

type SignalTree = {
  signal?: Record<string, unknown>
  children?: Record<string, SignalTree>
}

declare global {
  interface Window {
    avControlsArtwork: any
    avControlsController: any
    avControlsTimeline: any
  }
}

test.describe.configure({ mode: 'serial' })

function fixturePath(file: string, panelId = 'e2e-artwork') {
  const query = panelId === 'e2e-artwork' ? '' : `?panelId=${encodeURIComponent(panelId)}`
  return `${fixtureBaseUrl}/${file}${query}`
}

async function openArtworkAndController(browser: Browser, panelId = 'e2e-artwork') {
  const artworkPage = await browser.newPage()
  await artworkPage.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const controllerPage = await browser.newPage()
  await controllerPage.goto(fixturePath('controller.html', panelId))
  await controllerPage.evaluate(() => window.avControlsController.connect())
  await waitForRootSpec(controllerPage, panelId)

  return { artworkPage, controllerPage }
}

async function waitForRootSpec(controllerPage: Page, expectedName = 'e2e-artwork') {
  await expect.poll(async () => {
    return controllerPage.evaluate(() => window.avControlsController.getRootSpec()?.name)
  }).toBe(expectedName)
}

async function waitForUpdateCount(controllerPage: Page, count: number) {
  await expect.poll(async () => {
    return controllerPage.evaluate(() => window.avControlsController.getUpdates().length)
  }).toBe(count)
}

async function expectUpdateCountStays(controllerPage: Page, count: number) {
  await controllerPage.waitForTimeout(150)
  expect(await controllerPage.evaluate(() => window.avControlsController.getUpdates().length)).toBe(count)
}

function signalTree(leaves: Record<string, Record<string, unknown>>): SignalTree {
  const root: SignalTree = {}
  for (const [path, signal] of Object.entries(leaves)) {
    let node = root
    for (const part of path.split('.')) {
      node.children = node.children ?? {}
      node.children[part] = node.children[part] ?? {}
      node = node.children[part]
    }
    node.signal = signal
  }
  return root
}

function updateLeaf(update: any, path: string) {
  let node = update
  for (const part of path.split('.')) {
    node = node?.children?.[part]
  }
  return node?.update
}

test('single control signal updates artwork and echoes to controller', async ({ browser }) => {
  const { artworkPage, controllerPage } = await openArtworkAndController(browser)

  await controllerPage.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree)
  }, signalTree({ 'main.volume': { value: 0.7 } }))

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.7
      })
    })
  }).toBe(true)

  await waitForUpdateCount(controllerPage, 1)
  const update = await controllerPage.evaluate(() => window.avControlsController.getUpdates()[0])

  expect(updateLeaf(update.update, 'main.volume')).toEqual({ value: 0.7 })
  expect(update.origin?.kind).toBe('controller')
  expect(typeof update.serverSeq).toBe('number')
})

test('controller root sender interaction reaches artwork', async ({ browser }) => {
  const { artworkPage, controllerPage } = await openArtworkAndController(browser)

  await controllerPage.evaluate(() => {
    window.avControlsController.setLeafValue(['main', 'volume'], 0.58)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.58
      })
    })
  }).toBe(true)
})

test('real controller UI fader reaches artwork', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto(`${fixtureBaseUrl}/artwork.html`)
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const controllerPage = await browser.newPage()
  await controllerPage.goto(`${fixtureBaseUrl}/controller-ui.html`)
  const fader = controllerPage.locator('.control.fader .basis').first()
  await expect(fader).toBeVisible()

  const box = await fader.boundingBox()
  if (!box) {
    throw new Error('fader bounding box not available')
  }
  await controllerPage.mouse.click(box.x + box.width / 2, box.y + box.height * 0.25)

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && typeof change.value === 'number' && change.value > 0.6
      })
    })
  }).toBe(true)
})

test('timeline client automation reaches artwork as tree control signal', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto(`${fixtureBaseUrl}/artwork.html`)
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(`${fixtureBaseUrl}/timeline-client.html`)
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe('e2e-artwork')

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addVolumeCurve([
      { t: 0, v: 0.2 },
      { t: 1, v: 0.8 },
    ])
    window.avControlsTimeline.applyAutomation(1)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.8
      })
    })
  }).toBe(true)
})

test('timeline client does not receive its own automation echo', async ({ browser }) => {
  const panelId = 'e2e-timeline-no-self-echo'
  const artworkPage = await browser.newPage()
  await artworkPage.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(fixturePath('timeline-client.html', panelId))
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe(panelId)

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addVolumeCurve([
      { t: 0, v: 0.2 },
      { t: 1, v: 0.8 },
    ])
    window.avControlsTimeline.applyAutomation(1)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.8
      })
    })
  }).toBe(true)

  await timelinePage.waitForTimeout(150)
  expect(await timelinePage.evaluate(() => window.avControlsTimeline.getUpdates().length)).toBe(0)
})

test('timeline client batches multiple automation leaves into one tree signal', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto(`${fixtureBaseUrl}/artwork.html`)
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(`${fixtureBaseUrl}/timeline-client.html`)
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe('e2e-artwork')

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addMultiControlCurves()
    window.avControlsTimeline.applyAutomation(1)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => window.avControlsArtwork.getState())
  }).toMatchObject({
    states: {
      main: {
        states: {
          volume: { value: 0.65 },
        },
      },
      fx: {
        states: {
          amount: { value: 0.75 },
        },
      },
    },
  })
})

test('timeline backpressure collapses to latest continuous values without dropping trigger edges', async ({ browser }) => {
  const panelId = 'e2e-timeline-backpressure'
  const artworkPage = await browser.newPage()
  await artworkPage.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(fixturePath('timeline-client.html', panelId))
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe(panelId)

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addVolumeCurve([
      { t: 0, v: 0 },
      { t: 1, v: 1 },
    ])
    window.avControlsTimeline.addSwitchTrigger(0.3, 2)
    window.avControlsTimeline.setBufferedAmount(100)
    window.avControlsTimeline.applyAutomationWithBackpressure(0.25)
    window.avControlsTimeline.applyAutomationWithBackpressure(0.5)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => window.avControlsArtwork.getChanges().length)
  }).toBe(0)

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.setBufferedAmount(0)
    window.avControlsTimeline.applyAutomationWithBackpressure(0.75)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => window.avControlsArtwork.getState())
  }).toMatchObject({
    states: {
      main: {
        states: {
          volume: { value: 0.75 },
          enabled: { on: true },
        },
      },
    },
  })

  await artworkPage.waitForTimeout(80)
  const volumeChanges = await artworkPage.evaluate(() => {
    return window.avControlsArtwork.getChanges()
      .filter((change) => change.path === 'main.volume')
      .map((change) => change.value)
  })

  expect(volumeChanges).toEqual([0.75])
})

test('timeline reverse trigger sampling emits destination state only when crossing an event', async ({ browser }) => {
  const panelId = 'e2e-timeline-reverse-trigger'
  const artworkPage = await browser.newPage()
  await artworkPage.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(fixturePath('timeline-client.html', panelId))
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe(panelId)

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addSwitchTrigger(0.2, 0.8)
    window.avControlsTimeline.applyAutomation(1)
    window.avControlsTimeline.applyAutomation(0.5)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => window.avControlsArtwork.getState())
  }).toMatchObject({
    states: {
      main: {
        states: {
          enabled: { on: true },
        },
      },
    },
  })

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.applyAutomation(0.6)
    window.avControlsTimeline.applyAutomation(0.45)
  })
  await artworkPage.waitForTimeout(100)
  expect(await artworkPage.evaluate(() => {
    return window.avControlsArtwork.getChanges()
      .filter((change) => change.path === 'main.enabled')
      .map((change) => change.value)
  })).toEqual([false, true])

  await timelinePage.evaluate(() => window.avControlsTimeline.applyAutomation(0.1))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges()
        .filter((change) => change.path === 'main.enabled')
        .map((change) => change.value)
    })
  }).toEqual([false, true, false])
})

test('timeline reverse selector sampling uses the closest step at or before current time', async ({ browser }) => {
  const panelId = 'e2e-timeline-reverse-selector'
  const artworkPage = await browser.newPage()
  await artworkPage.goto(`${fixturePath('artwork.html', panelId)}&withMode=1`)
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const timelinePage = await browser.newPage()
  await timelinePage.goto(fixturePath('timeline-client.html', panelId))
  await timelinePage.evaluate(() => window.avControlsTimeline.connect())
  await expect.poll(async () => {
    return timelinePage.evaluate(() => window.avControlsTimeline.getRootSpecName())
  }).toBe(panelId)

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.addModeSteps([
      { t: 0, v: 0 },
      { t: 0.5, v: 1 },
      { t: 0.8, v: 2 },
    ])
    window.avControlsTimeline.applyAutomation(1)
    window.avControlsTimeline.applyAutomation(0.5)
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges()
        .filter((change) => change.path === 'main.mode')
        .map((change) => change.value)
    })
  }).toEqual([2, 1])

  await timelinePage.evaluate(() => {
    window.avControlsTimeline.applyAutomation(0.6)
    window.avControlsTimeline.applyAutomation(0.45)
  })
  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges()
        .filter((change) => change.path === 'main.mode')
        .map((change) => change.value)
    })
  }).toEqual([2, 1, 0])
})

test('nested multi-control signal applies and echoes as one update tree', async ({ browser }) => {
  const { artworkPage, controllerPage } = await openArtworkAndController(browser)

  await controllerPage.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree)
  }, signalTree({
    'main.volume': { value: 0.33 },
    'main.enabled': { on: true },
    'fx.amount': { value: 0.91 },
  }))

  await expect.poll(async () => {
    return artworkPage.evaluate(() => window.avControlsArtwork.getState())
  }).toMatchObject({
    states: {
      main: {
        states: {
          volume: { value: 0.33 },
          enabled: { on: true },
        },
      },
      fx: {
        states: {
          amount: { value: 0.91 },
        },
      },
    },
  })

  await waitForUpdateCount(controllerPage, 1)
  await expectUpdateCountStays(controllerPage, 1)
  const update = await controllerPage.evaluate(() => window.avControlsController.getUpdates()[0])
  const messageTypes = await controllerPage.evaluate(() => {
    return window.avControlsController.getMessages().map((message) => message.type)
  })

  expect(updateLeaf(update.update, 'main.volume')).toEqual({ value: 0.33 })
  expect(updateLeaf(update.update, 'main.enabled')).toEqual({ on: true })
  expect(updateLeaf(update.update, 'fx.amount')).toEqual({ value: 0.91 })
  expect(messageTypes).not.toContain('control-signal-batch')
  expect(messageTypes).not.toContain('control-update-batch')
})

test('serverSeq preserves broker order across controller signal and artwork update', async ({ browser }) => {
  const { artworkPage, controllerPage } = await openArtworkAndController(browser)

  await controllerPage.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree)
  }, signalTree({ 'main.volume': { value: 0.41 } }))

  await waitForUpdateCount(controllerPage, 1)
  await artworkPage.evaluate(() => {
    window.avControlsArtwork.emitArtworkUpdate('fx.amount', 0.82)
  })

  await waitForUpdateCount(controllerPage, 2)
  const updates = await controllerPage.evaluate(() => {
    return window.avControlsController.getUpdates().map((update) => ({
      origin: update.origin,
      serverSeq: update.serverSeq,
      update: update.update,
    }))
  })

  expect(updates[0].origin?.kind).toBe('controller')
  expect(updates[1].origin?.kind).toBe('artwork')
  expect(updateLeaf(updates[0].update, 'main.volume')).toEqual({ value: 0.41 })
  expect(updateLeaf(updates[1].update, 'fx.amount')).toEqual({ value: 0.82 })
  expect(typeof updates[0].serverSeq).toBe('number')
  expect(typeof updates[1].serverSeq).toBe('number')
  expect(updates[1].serverSeq!).toBeGreaterThan(updates[0].serverSeq!)
})

test('second controller receives timeline-like automation echo', async ({ browser }) => {
  const { controllerPage: controllerA } = await openArtworkAndController(browser)
  const controllerB = await browser.newPage()
  await controllerB.goto(`${fixtureBaseUrl}/controller.html`)
  await controllerB.evaluate(() => window.avControlsController.connect('controller-b'))
  await waitForRootSpec(controllerB)

  await controllerA.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree, { kind: 'timeline', clientId: 'timeline-e2e' })
  }, signalTree({
    'main.volume': { value: 0.64 },
    'main.enabled': { on: true },
    'fx.amount': { value: 0.27 },
  }))

  await waitForUpdateCount(controllerB, 1)
  const result = await controllerB.evaluate(() => {
    const update = window.avControlsController.getUpdates()[0]
    return {
      origin: update.origin,
      state: window.avControlsController.getRootSenderState(),
    }
  })

  expect(result.origin).toEqual({ kind: 'timeline', clientId: 'timeline-e2e' })
  expect(result.state).toMatchObject({
    states: {
      main: {
        states: {
          volume: { value: 0.64 },
          enabled: { on: true },
        },
      },
      fx: {
        states: {
          amount: { value: 0.27 },
        },
      },
    },
  })
})

test('controller stays subscribed and receives broker-cached state after artwork reload', async ({ browser }) => {
  const panelId = 'e2e-reload-cached'
  const { artworkPage, controllerPage } = await openArtworkAndController(browser, panelId)

  await controllerPage.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree)
  }, signalTree({ 'main.volume': { value: 0.7 } }))

  await waitForUpdateCount(controllerPage, 1)
  await artworkPage.close()

  const reloadedArtworkPage = await browser.newPage()
  await reloadedArtworkPage.goto(fixturePath('artwork.html', panelId))

  await expect.poll(async () => {
    return reloadedArtworkPage.evaluate(() => {
      return window.avControlsArtwork.getState().states.main.states.volume.value
    })
  }).toBe(0.7)

  await expect.poll(async () => {
    return controllerPage.evaluate(() => {
      return window.avControlsController.getRootSpecs().some((spec) => {
        return spec.name === 'e2e-reload-cached'
          && spec.stateInitialized === true
          && spec.currentState.states.main.states.volume.value === 0.7
      })
    })
  }).toBe(true)

  await controllerPage.evaluate((tree) => {
    window.avControlsController.sendSignalTree(tree)
  }, signalTree({ 'main.volume': { value: 0.44 } }))

  await expect.poll(async () => {
    return reloadedArtworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.44
      })
    })
  }).toBe(true)
})

test('offline subscription receives initial state marker and restores stored controller state on artwork return', async ({ browser }) => {
  const panelId = 'e2e-reload-initial'
  const artworkPage = await browser.newPage()
  await artworkPage.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkPage.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const storedState = await artworkPage.evaluate(() => {
    const state = JSON.parse(JSON.stringify(window.avControlsArtwork.getState()))
    state.states.main.states.volume.value = 0.88
    state.states.main.states.enabled.on = true
    state.states.fx.states.amount.value = 0.36
    return state
  })
  await artworkPage.close()

  const controllerPage = await browser.newPage()
  await controllerPage.goto(fixturePath('controller.html', panelId))
  await controllerPage.evaluate((state) => {
    window.avControlsController.setStoredInitialState(state)
    window.avControlsController.connect('offline-subscriber')
  }, storedState)

  await controllerPage.waitForTimeout(150)
  expect(await controllerPage.evaluate(() => window.avControlsController.getRootSpec())).toBe(null)

  const reloadedArtworkPage = await browser.newPage()
  await reloadedArtworkPage.goto(fixturePath('artwork.html', panelId))

  await expect.poll(async () => {
    return controllerPage.evaluate(() => {
      return window.avControlsController.getRootSpecs().some((spec) => {
        return spec.name === 'e2e-reload-initial' && spec.stateInitialized === false
      })
    })
  }).toBe(true)

  await expect.poll(async () => {
    return reloadedArtworkPage.evaluate(() => window.avControlsArtwork.getState())
  }).toMatchObject({
    states: {
      main: {
        states: {
          volume: { value: 0.88 },
          enabled: { on: true },
        },
      },
      fx: {
        states: {
          amount: { value: 0.36 },
        },
      },
    },
  })

  await expect.poll(async () => {
    return controllerPage.evaluate(() => {
      return window.avControlsController.getRootSpecs().some((spec) => {
        return spec.name === 'e2e-reload-initial'
          && spec.stateInitialized === true
          && spec.currentState.states.main.states.volume.value === 0.88
      })
    })
  }).toBe(true)

  await controllerPage.evaluate(() => {
    window.avControlsController.setLeafValue(['main', 'volume'], 0.22)
  })

  await expect.poll(async () => {
    return reloadedArtworkPage.evaluate(() => {
      return window.avControlsArtwork.getChanges().some((change) => {
        return change.path === 'main.volume' && change.value === 0.22
      })
    })
  }).toBe(true)
})

test('broker ignores stale receiver updates after a replacement artwork owns the panel', async ({ browser }) => {
  const panelId = 'e2e-stale-receiver'
  const artworkA = await browser.newPage()
  await artworkA.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return artworkA.evaluate(() => typeof window.avControlsArtwork?.getState === 'function')
  }).toBe(true)

  const controllerPage = await browser.newPage()
  await controllerPage.goto(fixturePath('controller.html', panelId))
  await controllerPage.evaluate(() => window.avControlsController.connect('stale-receiver-controller'))
  await waitForRootSpec(controllerPage, panelId)

  const artworkB = await browser.newPage()
  await artworkB.goto(fixturePath('artwork.html', panelId))
  await expect.poll(async () => {
    return controllerPage.evaluate(() => window.avControlsController.getRootSpecs().length)
  }).toBeGreaterThan(1)

  await artworkA.evaluate(() => {
    window.avControlsArtwork.emitArtworkUpdate('fx.amount', 0.91)
  })
  await expectUpdateCountStays(controllerPage, 0)

  await artworkB.evaluate(() => {
    window.avControlsArtwork.emitArtworkUpdate('fx.amount', 0.42)
  })
  await waitForUpdateCount(controllerPage, 1)
  const update = await controllerPage.evaluate(() => window.avControlsController.getUpdates()[0])
  expect(updateLeaf(update.update, 'fx.amount')).toEqual({ value: 0.42 })
})
