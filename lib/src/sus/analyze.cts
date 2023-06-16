type Line = [string, string]

type MeasureChange = [number, number]

type Meta = Map<string, string>

type BarLengthObject = {
    measure: number
    length: number
}

type RawObject = {
    tick: number
    value: string
}

export type TimeScaleChangeObject = {
    tick: number
    timeScale: number
}

export type BpmChangeObject = {
    tick: number
    bpm: number
}

export type NoteObject = {
    tick: number
    lane: number
    width: number
    type: number
}

export type Score = {
    offset: number
    ticksPerBeat: number
    timeScaleChanges: TimeScaleChangeObject[]
    bpmChanges: BpmChangeObject[]
    tapNotes: NoteObject[]
    directionalNotes: NoteObject[]
    slides: NoteObject[][]
}

type ToTick = (measure: number, p: number, q: number) => number

export const analyze = (sus: string): Score => {
    const { lines, measureChanges, meta } = parse(sus)

    const offset = -+(meta.get('WAVEOFFSET') || '0')
    if (Number.isNaN(offset)) throw 'Unexpected offset'

    const ticksPerBeat = getTicksPerBeat(meta)
    if (!ticksPerBeat) throw 'Missing or unexpected ticks per beat'

    const barLengths = getBarLengths(lines, measureChanges)

    const toTick = getToTick(barLengths, ticksPerBeat)

    const bpms = new Map<string, number>()
    const bpmChanges: BpmChangeObject[] = []
    const timeScaleChanges: TimeScaleChangeObject[] = []
    const tapNotes: NoteObject[] = []
    const directionalNotes: NoteObject[] = []
    const streams = new Map<string, NoteObject[]>()

    lines.forEach((line, index) => {
        const [header, data] = line
        const measureOffset = measureChanges.find(([changeIndex]) => changeIndex <= index)?.[1] ?? 0

        // Time Scale Changes
        if (header.length === 5 && header.startsWith('TIL')) {
            timeScaleChanges.push(...toTimeScaleChanges(line, toTick))
            return
        }

        // BPM
        if (header.length === 5 && header.startsWith('BPM')) {
            bpms.set(header.substring(3), +data)
            return
        }

        // BPM Changes
        if (header.length === 5 && header.endsWith('08')) {
            bpmChanges.push(...toBpmChanges(line, measureOffset, bpms, toTick))
            return
        }

        // Tap Notes
        if (header.length === 5 && header[3] === '1') {
            tapNotes.push(...toNotes(line, measureOffset, toTick))
            return
        }

        // Streams
        if (header.length === 6 && header[3] === '3') {
            const channel = header[5]
            const stream = streams.get(channel)

            if (stream) {
                stream.push(...toNotes(line, measureOffset, toTick))
            } else {
                streams.set(channel, toNotes(line, measureOffset, toTick))
            }
            return
        }

        // Directional Notes
        if (header.length === 5 && header[3] === '5') {
            directionalNotes.push(...toNotes(line, measureOffset, toTick))
            return
        }
    })

    const slides = [...streams.values()].map(toSlides).flat()

    return {
        offset,
        ticksPerBeat,
        timeScaleChanges,
        bpmChanges,
        tapNotes,
        directionalNotes,
        slides,
    }
}

const parse = (
    sus: string,
): {
    lines: Line[]
    measureChanges: MeasureChange[]
    meta: Meta
} => {
    const lines: Line[] = []
    const measureChanges: MeasureChange[] = []
    const meta: Meta = new Map()

    sus.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('#'))
        .forEach((line) => {
            const isLine = line.includes(':')

            const index = line.indexOf(isLine ? ':' : ' ')
            if (index === -1) return

            const left = line.substring(1, index).trim()
            const right = line.substring(index + 1).trim()

            if (isLine) {
                lines.push([left, right])
            } else if (left === 'MEASUREBS') {
                measureChanges.unshift([lines.length, +right])
            } else {
                meta.set(left, right)
            }
        })

    return {
        lines,
        measureChanges,
        meta,
    }
}

const getTicksPerBeat = (meta: Map<string, string>) => {
    const request = meta.get('REQUEST')
    if (!request) return

    if (!request.startsWith('"ticks_per_beat ') || !request.endsWith('"')) return

    return +request.slice(16, -1)
}

const getBarLengths = (lines: Line[], measureChanges: MeasureChange[]) => {
    const barLengths: BarLengthObject[] = []

    lines.forEach((line, index) => {
        const [header, data] = line

        if (header.length !== 5) return
        if (!header.endsWith('02')) return

        const measure =
            +header.substring(0, 3) +
            (measureChanges.find(([changeIndex]) => changeIndex <= index)?.[1] ?? 0)
        if (Number.isNaN(measure)) return

        barLengths.push({ measure, length: +data })
    })

    return barLengths
}

const getToTick = (barLengths: BarLengthObject[], ticksPerBeat: number): ToTick => {
    let ticks = 0
    const bars = barLengths
        .sort((a, b) => a.measure - b.measure)
        .map(({ measure, length }, i, values) => {
            const prev = values[i - 1]
            if (prev) {
                ticks += (measure - prev.measure) * prev.length * ticksPerBeat
            }

            return { measure, ticksPerMeasure: length * ticksPerBeat, ticks }
        })
        .reverse()

    return (measure, p, q) => {
        const bar = bars.find((bar) => measure >= bar.measure)
        if (!bar) throw 'Unexpected missing bar'

        return (
            bar.ticks +
            (measure - bar.measure) * bar.ticksPerMeasure +
            (p * bar.ticksPerMeasure) / q
        )
    }
}

const toBpmChanges = (
    line: Line,
    measureOffset: number,
    bpms: Map<string, number>,
    toTick: ToTick,
) =>
    toRaws(line, measureOffset, toTick).map(({ tick, value }) => ({
        tick,
        bpm: bpms.get(value) || 0,
    }))

const toTimeScaleChanges = ([, data]: Line, toTick: ToTick) => {
    if (!data.startsWith('"') || !data.endsWith('"')) throw 'Unexpected time scale changes'

    return data
        .slice(1, -1)
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => !!segment)
        .map((segment) => {
            const [l, rest] = segment.split("'")
            const [m, r] = rest.split(':')

            const measure = +l
            const tick = +m
            const timeScale = +r

            if (Number.isNaN(measure) || Number.isNaN(tick) || Number.isNaN(timeScale))
                throw 'Unexpected time scale change'

            return {
                tick: toTick(measure, 0, 1) + tick,
                timeScale,
            }
        })
        .sort((a, b) => a.tick - b.tick)
}

const toNotes = (line: Line, measureOffset: number, toTick: ToTick) => {
    const [header] = line
    const lane = parseInt(header[4], 36)

    return toRaws(line, measureOffset, toTick).map(({ tick, value }) => {
        const width = parseInt(value[1], 36)

        return {
            tick,
            lane,
            width,
            type: parseInt(value[0], 36),
        }
    })
}

const toSlides = (stream: NoteObject[]) => {
    const slides: NoteObject[][] = []

    let current: NoteObject[] | undefined
    stream
        .sort((a, b) => a.tick - b.tick)
        .forEach((note) => {
            if (!current) {
                current = []
                slides.push(current)
            }

            current.push(note)

            if (note.type === 2) {
                current = undefined
            }
        })

    return slides
}

const toRaws = ([header, data]: Line, measureOffset: number, toTick: ToTick) => {
    const measure = +header.substring(0, 3) + measureOffset
    return (data.match(/.{2}/g) || [])
        .map(
            (value, i, values) =>
                value !== '00' && {
                    tick: toTick(measure, i, values.length),
                    value,
                },
        )
        .filter((object): object is RawObject => !!object)
}
