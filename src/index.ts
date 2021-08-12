import dotenv from 'dotenv'

dotenv.config()

import path from 'path'

import { Browser, launch } from 'puppeteer'

import {createDomain, forward, attach, sample, guard, createEvent} from 'effector'
import {debounce} from 'patronum'

import fs from 'fs/promises'

import multer from 'multer'

import cors from 'cors'

import JSZip from 'jszip'

import FormData from 'form-data'
import fetch from 'node-fetch'

import express, {Request, Response} from 'express'

// import {magicAuth} from './middlewares/magic.auth'

const PORT = parseInt(process.env.PORT || '') || 7013

const PARALLEL_PAGES = parseInt(process.env.PARALLEL_PAGES || '') || 4

const PAGES: any = {}

const config = {
    uploader: {
        endpoint: `${
            process.env.API_BASE_URL || 'http://localhost:6210'
          }/addOneFileToLocationInternal`,
          token: process.env.API_TOKEN || '',
    }
}

const app = createDomain()

const cancelGenerationForLocation = createEvent<number>()

const oncomplete = app.createEvent<{pageId: number, locationId: number, cubes: any[]}>()
const onnewcube = app.createEvent<{locationId: number, cube: any}>()
const onequigenerate = app.createEvent<number>()

const clearLocationCubesToSend = app.createEvent<number>()

const locationCubesToSend$ = app.createStore<any>({})
    .on(onnewcube, (locations, {locationId, cube}: {locationId: number, cube: any}) => {
        if(locations[locationId]) {
            locations[locationId].push(cube)
        } else {
            locations[locationId] = [cube]
        }

        return {...locations}
    })
    .on(clearLocationCubesToSend, (locations, locationId) => {
        locations[locationId] = []

        return {...locations}
    })

const generationStatsDec = app.createEvent<{locationId: number, qty: number}>()
const generationStats$ = app.createStore<{[locationId: number]: number}>({})
    .on(generationStatsDec, (stats, {locationId, qty}) => {
        if(!stats[locationId]) return {...stats}

        if(stats[locationId] < qty) {
            delete stats[locationId]
        } else {
            stats[locationId] -= qty
        }

        return {...stats}
    })
    .on(cancelGenerationForLocation, (stats, locationId) => {
        delete stats[locationId]

        return {...stats}
    })

forward({from: onequigenerate, to: generationStatsDec.prepend(locationId => ({locationId, qty: 1}))})

const init = app.createEvent()

const launchBrowserFx = app.createEffect(() => {
    return launch({
        headless: true,
        args: [
            '--disable-dev-shm-usage',
            '--enable-features=NetworkService',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--shm-size=8gb'
        ],
        ...(process.env.PUPPETEER_BROWSER_PATH ? {executablePath: process.env.PUPPETEER_BROWSER_PATH} : {})
    })
})

launchBrowserFx.failData.watch(console.log)

const browser$ = app
    .createStore<Browser | null>(null)
    .on(launchBrowserFx.doneData, (_, browser) => browser)

forward({
    from: init,
    to: [launchBrowserFx]
})

const pageIdled = createEvent<number>()

const setBrowserPageLocationId = createEvent<{pageId: number, locationId: number}>()
const browserPages$ = app.createStore<{id: number, status: 'processing' | 'idle', locationId?: number}[]>(
    Array.from({length: PARALLEL_PAGES}, (_, id) => ({id: id + 1, status: 'idle'}))
)
    .on(pageIdled, (pages, pageId) => {
        const idx = pages.findIndex(p => p.id === pageId)

        pages[idx].status = 'idle'

        return [...pages]
    })
    .on(setBrowserPageLocationId, (pages, {pageId, locationId}) => {
        const idx = pages.findIndex(p => p.id === pageId)

        pages[idx].locationId = locationId
    })

const pushToEquiGenerationQueue = app.createEvent<any>()
const consumeEquiGenerationQueue = createEvent()

const equiGenerationQueue$ = app.createStore<any[]>([])
    .on(pushToEquiGenerationQueue, (queue, value) => ([...queue, value]))
    .on(consumeEquiGenerationQueue, ([_, ...queue]) => queue)
    .on(cancelGenerationForLocation, (queue, id) => queue.filter(x => x.locationId !== id))

const generateCubes = createEvent<{locationId: number, quality: number, resolutions: string, files: any[]}>()

const consumePageGenerationQueue = createEvent()
const pushToPageGenerationQueue = createEvent<{payload: any, page: any}>()

const pageGenerationQueue$ = app.createStore<{payload: any, page: any}[]>([])
    .on(pushToPageGenerationQueue, (queue, value) => ([...queue, value]))
    .on(consumePageGenerationQueue, ([_, ...queue]) => queue)

const tryRunPageGeneration = createEvent<{payload: any, page: any}>()

const pageRunGenerationFx = app.createEffect<{payload: any, page: any}, any>(async ({payload, page}) => {
    const browser = browser$.getState()

    const {quality, locationId, resolutions, files} = payload

    const dirPath = path.resolve(__dirname, String(locationId))
    await fs.mkdir(dirPath).catch(() => {})

    for(const file of files) {
        await fs.writeFile(path.resolve(dirPath, file.originalname), file.buffer, 'binary')
    }

    const browserPage = await browser.newPage()
    await browserPage.bringToFront()
    await browserPage.exposeFunction('onnewcube', onnewcube)
    await browserPage.exposeFunction('oncomplete', oncomplete)
    await browserPage.exposeFunction('onequigenerate', onequigenerate)

    await browserPage.goto('http://localhost:'+PORT, { waitUntil: 'domcontentloaded' })

    PAGES[page.id] = browserPage

    const _browserPage: any = browserPage
    _browserPage.id = page.id

    await new Promise(rs => setTimeout(rs, 1000))

    const elementHandle = await browserPage.$('#file')

    await elementHandle.uploadFile(
        ...files.map((file: any) => path.resolve(dirPath, file.originalname))
    )

    await browserPage.$eval('#quality', (el: any, value) => el.value = value, quality)
    await browserPage.$eval('#PORT', (el: any, value) => el.value = value, PORT)
    await browserPage.$eval('#locationId', (el: any, value) => el.value = value, locationId)
    await browserPage.$eval('#resolutions', (el: any, value) => el.value = value, resolutions)
    await browserPage.$eval('#pageId', (el: any, value) => el.value = value, page.id)

    await browserPage.click('#generate')

    await new Promise(rs => setTimeout(rs, 1000))

    return {payload, page}
})

pageRunGenerationFx.fail.watch(console.error)

guard({
    source: tryRunPageGeneration,
    filter: pageRunGenerationFx.pending.map(x => !x),
    target: pageRunGenerationFx
})

guard({
    source: tryRunPageGeneration,
    filter: pageRunGenerationFx.pending,
    target: pushToPageGenerationQueue
})

guard({
    source: pageGenerationQueue$,
    clock: pageRunGenerationFx.done,
    filter: queue => queue.length > 0,
    target: [
        pageRunGenerationFx.prepend(([value]) => value),
        consumePageGenerationQueue
    ]
})

const pageGenerateCubesFx = attach({
    source: browser$,
    mapParams({
        page,
        payload
    }: {page: {id: number, status: 'idle' | 'processing'}, payload: {quality: number, locationId: number, resolutions: string, files: any[]}}, browser) {
        return {page, payload, browser}
    },
    effect: app.createEffect<{page: any, payload: any, browser: Browser}, any>(async ({page, payload, browser}) => {
        return new Promise(async (rs, rj) => {
            const completeUnwatch = oncomplete.watch(async ({pageId, locationId, cubes}) => {
                if(pageId == page.id) {
                    completeUnwatch()
                    cancelUnwatch()

                    const dirPath = path.resolve(__dirname, String(locationId))
                    for(const file of payload.files) {
                        await fs.unlink(path.resolve(__dirname, dirPath, file.originalname)).catch(() => {})
                    }

                    // const browserPage = await browser$.getState().pages().then(pages => pages.find(((p: any) => p.id == pageId)))
                    const browserPage = PAGES[page.id]
                    try {
                        if(!browserPage.isClosed()) {
                            await browserPage.bringToFront()
                            await browserPage.close()
                        } else {
                            console.log('Page was closed before!', pageId)
                        }
                    } catch(e) {
                        console.log('Page was closed before!', pageId)
                    }

                    pageIdled(page.id)
                    
                    rs({locationId})
                }
            })

            const cancelUnwatch = cancelGenerationForLocation.watch(async locationId => {
                if(locationId !== payload.locationId) return

                completeUnwatch()   
                cancelUnwatch()

                // const browser = browser$.getState()
                const browserPage = PAGES[page.id]
                // const browserPage = await browser.pages().then(pages => pages.find(((p: any) => p.id === page.id)))
                await browserPage.bringToFront()
                await browserPage.close()

                await new Promise(rs => setTimeout(rs, 500))

                const dirPath = path.resolve(__dirname, String(locationId))
                // await fs.rmdir(dirPath, {recursive: true}).catch(() => {})
                for(const file of payload.files) {
                    await fs.unlink(path.resolve(__dirname, dirPath, file.originalname)).catch(() => {})
                }


                pageIdled(page.id)
                rj('cancel')
            })
        })
    })
})

pageGenerateCubesFx.failData.watch(console.error)

forward({from: pageRunGenerationFx.doneData, to: pageGenerateCubesFx})

guard({
    source: {queue: equiGenerationQueue$, pages: browserPages$},
    clock: [debounce({source: pageGenerateCubesFx.done, timeout: 0})],
    filter: ({queue, pages}) => queue.length > 0 && pages.some(p => p.status === 'idle'),
    target: [
        generateCubes.prepend(({queue}: any) => queue[0]),
        consumeEquiGenerationQueue
    ]
})

sample({
    source: generateCubes,
    clock: guard({
        source: browserPages$,
        clock: generateCubes,
        filter: (pages) => pages.some(p => p.status === 'idle')
    }),
    fn(payload, pages) {
        return {
            page: pages.find(p => p.status === 'idle'),
            payload
        }
    },
    target: tryRunPageGeneration
})

sample({
    source: generateCubes,
    clock: guard({
        source: browserPages$,
        clock: generateCubes,
        filter: pages => !pages.some(p => p.status === 'idle')
    }),
    target: pushToEquiGenerationQueue
})

sample({
    source: browserPages$,
    clock: tryRunPageGeneration,
    fn(pages, {page}) {
        const idx = pages.findIndex(p => p.id === page.id)
        pages[idx].status = 'processing'

        return [...pages]
    },
    target: browserPages$
})

sample({
    source: browserPages$,
    clock: pageGenerateCubesFx.done,
    fn(pages, {params: {page}}) {
        const idx = pages.findIndex(p => p.id === page.id)
        pages[idx].status = 'idle'

        return [...pages]
    },
    target: browserPages$
})

sample({
    source: generationStats$,
    clock: pageRunGenerationFx,
    fn(stats, {payload}) {
        return {
            ...stats,
            [payload.locationId]: (stats[payload.locationId] || 0) + payload.files.length
        }
    },
    target: generationStats$
})

const server = express()
const upload = multer()

server.use(express.json())
server.use(cors())
server.use(express.static(path.resolve(__dirname, '../browser-src')))

const splitEvery = (arr: any[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );

import AdmZip from 'adm-zip'

server.post('/process/cubemap', /*magicAuth() as any, */ upload.array('file'), async (req, res) => {
    const locationId: number = parseInt(req.body.location)
    const quality: number = parseInt(req.body.quality) || 85

    const files: any[] = req.files as any[]
    const resolutions: string = req.body.resolutions

    if(isNaN(locationId) || locationId < 1) return res.status(400).end('Invalid location id')
    
    try {
        if(files.length === 1 && ['.zip', '.rar'].some(ext => files[0].originalname.includes(ext))) {
            const zip = new AdmZip(files[0].buffer);
            
            const images = zip.getEntries().map(x => ({
                originalname: x.name,
                buffer: x.getData()
            }));

            for(const chunk of splitEvery(images, resolutions.split(',').map(Number).includes(4096) ? 1 : 4)) {
                generateCubes({
                    locationId,
                    resolutions,
                    files: chunk,
                    quality
                })
            }


        } else {
            for(const chunk of splitEvery(files, resolutions.split(',').map(Number).includes(4096) ? 1 : 4)) {
                generateCubes({
                    locationId,
                    resolutions,
                    files: chunk,
                    quality
                })
            }
        }

        res.json({result: {message: 'success'}, status:200});
    } catch(e) {
        res.status(500).json(e);
    }
})

server.get('/jobs/remove', (req, res) => {
    if(!req.query.location) return res.status(500).end('Location is requred')
    const locationId = parseInt(req.query.location as string)

    cancelGenerationForLocation(locationId)
    
    res.json({result: {message: 'success'}, status:200})
})

server.get('/jobs/stats', (req: Request, res: Response) => {
    if(!req.query.location) return res.status(500).end('Location is requred')
    const locationId = parseInt(req.query.location as string)

    const equiGenerationQueue = equiGenerationQueue$.getState()

    res.json({
        active: (
            (generationStats$.getState()[locationId] || 0) +
            equiGenerationQueue
                .filter(x => x.locationId === locationId)
                .reduce((acc, {files}) => acc + files.length, 0)
        ),
        beforeLocation: equiGenerationQueue.reduce(({value, skip}, x) => {
            if(x.locationId === locationId || skip) return {value, skip: true}

            return {skip, value: value + x.files.length}
        }, {value: 0, skip: false}).value
    })
})

sample({
    source: locationCubesToSend$,
    clock: pageGenerateCubesFx.doneData,
    fn(locations, {locationId}) {
        return {locationId, cubes: locations[locationId]}
    }
})
    .watch(async ({cubes, locationId}) => {
        if(!cubes || cubes.length === 0) return
        const zip = new JSZip()
        cubes.forEach((cube: any) => {
            if(cube.isBase64) {
                zip.file(`cube/${cube.name}.jpg`, cube.tileArray.split('base64,')[1], {base64: true})
            } else {
                zip.file(`cube/${cube.name}.jpg`, Buffer.from(Object.values(cube.tileArray) as number[]))
            }
        })
        
        await zip.generateAsync({ type: 'nodebuffer' }).then(async (buffer: any) => {
            const fd = new FormData()

            fd.append('id', locationId)
            fd.append('file', buffer, { filename: 'archive.zip' })
            const accessHeader = { 'X-Access-Token': config.uploader.token }

            fetch(config.uploader.endpoint, {
                method: 'POST',
                headers: accessHeader,
                body: fd,
            })
                .catch(console.error)
        })

        clearLocationCubesToSend(locationId)
    })

init()
server.listen(PORT, () => console.log(`Listen :${PORT}`))