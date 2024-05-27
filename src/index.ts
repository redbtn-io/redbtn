import { randomUUID } from "crypto"
const imports: any = {}

/**
 * @namespace REDBTN
 * @description REDBTN is an object representing the app state.
 */
const REDBTN:REDBTN = {
    options: {
        freq: 2000
    },
    automations: {},
    data: {},
    active: false
}


/**
 * Sets the options for REDBTN.
 * @param options - The options to set.
 */
export async function setOptions(options: any) {
    REDBTN.options = options
}


/**
 * The main function that runs the REDBTN system.
 * It loops through all the automations and runs their triggers.
 * It then checks the conditions of the actions and runs them if the conditions are met.
 */
async function main() {
    for await (const id of Object.keys(REDBTN.automations)) {
        const automation = REDBTN.automations[id]
        const loaders = automation?.loaders
        if (loaders) for await (const loader of loaders) {
            await loader.connector[loader.action](loader.params, REDBTN)
        }
        const triggers = automation?.triggers
        if (!triggers) continue
        const runResults = await Promise.all( triggers.map(async (trigger:Trigger) => { 
            return await trigger.connector[trigger.action](trigger.params, REDBTN)
        }))
        const runString = runResults.map((result:any) => (!result ? 'f' : 't'))
            .join('')
        const results: any[] = []
        if (!automation.actions) continue
        for await (const action of automation.actions) {
            if (action.condition == runString) results.push(await action.connector[action.action](action.params, REDBTN))
        }
        if (results.length > 0 && REDBTN.listener) REDBTN.listener([id, results])
    }
    if (REDBTN.finisher) REDBTN.finisher(REDBTN)
    if (REDBTN.active) REDBTN.interval = setTimeout(main, REDBTN.options.freq)
}

/**
 * Starts the REDBTN system.
 * @param options - The options to start the system with.
 * @returns The REDBTN object.
 */
async function start(options?: any) {
    if (options) REDBTN.options = options
    REDBTN.active = true
    REDBTN.interval = setTimeout(main, REDBTN.options.freq)
    return REDBTN
}

/**
 * Stops the REDBTN system.
 * @returns A boolean indicating whether the system was stopped successfully.
 */
async function stop() {
    try {
        REDBTN.active = false
        if (REDBTN.interval) clearTimeout(REDBTN.interval)
        return true
    } catch (error) {
        return false
    }
}


/**
 * Adds an automation to the REDBTN system.
 * @param params - The automation creation parameters.
 * @returns The added automation.
 * @throws Error if the automation is missing required properties or if the module is not found.
 */
export async function add(params: AutomationCreationParams) {
    console.log('adding')
    try {
        const automation: Automation = params as Automation
        if (automation.persistent) {
            const packagePath = automation.persistent.package.startsWith('./') ? automation.persistent.package.replace('./', '../../../') : automation.persistent.package
            const connector = imports[automation.persistent.package] || await import(packagePath)
            imports[automation.persistent.package] = connector
            automation.persistent.connector = connector
            const persistModule = automation.persistent.module ? connector[automation.persistent.module] : connector.default
            if (!persistModule) throw new Error('Module not found, ensure module contains default export class or specify module in automation config')
            if (!persistModule.prototype._kill) throw new Error('Module must contain _kill method')
            if (!automation.persistent.params) automation.persistent.params = {}
            automation.persistent.process = new persistModule(automation.persistent.params, REDBTN.listener)
        }
        if (automation.loaders) for await(const loader of automation.loaders) {
            const packagePath = loader.package.startsWith('./') ? loader.package.replace('./', '../../../') : loader.package
            const connector = imports[loader.package] || await import(packagePath)
            imports[loader.package] = connector
            loader.connector = connector
        }
        if (automation.triggers) for await(const algo of automation.triggers) {
            const packagePath = algo.package.startsWith('./') ? algo.package.replace('./', '../../../') : algo.package
            const connector = imports[algo.package] || await import(packagePath)
            imports[algo.package] = connector
            algo.connector = connector
        }
        if (automation.actions) for await(const action of automation.actions) {
            const packagePath = action.package.startsWith('./') ? action.package.replace('./', '../../../') : action.package
            const connector = imports[action.package] || await import(packagePath)
            imports[action.package] = connector
            action.connector = connector
        }
        if (!automation.actions && !automation.triggers && !automation.persistent) 
            throw new Error('Automation must contain at least one action, trigger or persistent process')
        if (!automation.id) automation.id = randomUUID()
        REDBTN.automations[automation.id] = automation
        console.log(!REDBTN.interval && automation.triggers)
        if (!REDBTN.interval && automation.triggers) start()
        return automation
    } catch (error) {
        console.log(error)
        return error
    }
}

/**
 * Removes an automation from the REDBTN system.
 * @param id - The ID of the automation to remove.
 * @returns A boolean indicating whether the automation was removed successfully.
 */
export async function remove(id: string) {
    try {
        if (REDBTN.automations[id].persistent) {
            REDBTN.automations[id].persistent?.process?._kill()
        }
        delete REDBTN.automations[id]
        if (Object.keys(REDBTN.automations).length == 0) stop()
        return true
    } catch (error) {
        return error
    }
}

/**
 * Edits an automation in the REDBTN system.
 * @param id - The ID of the automation to edit.
 * @param params - The automation creation parameters to edit.
 * @returns The edited automation.
 */

export async function edit(id: string, params: AutomationCreationParams) {
    try {
        const automation = {...REDBTN.automations[id], ...params}
        await remove(id)
        return await add(automation)
    } catch (error) {
        return error
    }
};

/**
 * Sets the data for REDBTN.
 */
export async function set(data: any) {
    REDBTN.data = data
}

/**
 * Sets the listener function for REDBTN.
 * @param callback - The listener function to set.
 */
export async function listen(callback: Function) {
    REDBTN.listener = callback
}

/**
 * Sets the finisher function for REDBTN.
 * @param callback - The finisher function to set.
 */
export async function finish(callback: Function) {
    REDBTN.finisher = callback
}

// Getters

/**
 * Retrieves the status of the REDBTN system.
 * @returns The status of the REDBTN system.
 */
export function status() {
    const status: any = {...REDBTN}
    delete status.listener
    delete status.interval
    status.automations = Object.keys(status.automations)
    console.log(status)
    return JSON.parse(JSON.stringify(status))
}

/**
 * Retrieves all the automations in the REDBTN system.
 * @returns An object containing all the automations in the REDBTN system.
 */
export function automations() {
    const automations = {...REDBTN.automations}
    Object.keys(automations).forEach((r:any) => {
        automations[r] = automation(r)
    })
    return automations
}

/**
 * Retrieves a specific automation from the REDBTN system.
 * @param id - The ID of the automation to retrieve.
 * @returns The automation object.
 */
export function automation(id: string) {
    const ref = REDBTN.automations[id]
    if (!ref) return null
    const automation: any = {name: ref.name, id: ref.id}
    if (ref.loaders) automation.loaders = ref.loaders.map((loader: any) => {
        return { package: loader.package, action: loader.action, params: loader.params }
    })
    if (ref.triggers) automation.triggers = ref.triggers.map((algo: any) => {
        return { package: algo.package, action: algo.action, params: algo.params }
    })
    if (ref.actions) automation.actions = ref.actions.map((action: any) => {
        return { package: action.package, condition: action.condition, action: action.action, params: action.params }
    })
    if (ref.persistent) {
        automation.persistent = { package: ref.persistent.package, params: ref.persistent.params }
        if (ref.persistent.module) automation.persistent.module = ref.persistent.module
    }
    return automation
}

/**
 * Represents the REDBTN system.
 */

interface REDBTN {
    options: Options,
    automations: Automations,
    interval?: NodeJS.Timeout,
    data: any,
    listener?: Function,
    finisher?: Function,
    active: boolean
}

/**
 * Represents an automation in the REDBTN system.
 */
export interface Automation {
    name: string,
    id: string,
    loaders?: Loader[],
    triggers?: Trigger[],
    actions?: Action[],
    persistent?: Persistent
}

/**
 * Represents a set of automations in the REDBTN system.
 */
export interface Automations {
    [id: string]: Automation
}

/**
 * Represents a set of options for the REDBTN system.
 */
export interface Options {
    freq: number,
    [name: string]: string|number|boolean
}

/**
 * Represents a loader in the REDBTN system.
 */
export interface Loader {
    package: string,
    action: string,
    params: any,
    connector: any
}

/**
 * Represents a trigger in the REDBTN system.
 */
export interface Trigger {
    package: string,
    action: string,
    params: any,
    connector: any
}

/**
 * Represents an action in the REDBTN system.
 */
export interface Action {
    package: string,
    condition: string,
    action: string,
    params: any,
    connector: any
}

/**
 * Represents a persistent process in the REDBTN system.
 */
export interface Persistent {
    package: string,
    module?: string,
    params: any,
    connector?: any,
    process?: any
}

/**
 * Represents the creation parameters for an automation in the REDBTN system.
 */
export interface AutomationCreationParams {
    name: string,
    id?: string,
    loaders?: LoaderCreationParams[],
    triggers?: TriggerCreationParams[],
    actions?: ActionCreationParams[],
    persistent?: PersistentCreationParams
}

/**
 * Represents the creation parameters for a loader in the REDBTN system.
 */
export interface LoaderCreationParams {
    package: string,
    action: string,
    params?: any
}

/**
 * Represents the creation parameters for a trigger in the REDBTN system.
 */
export interface TriggerCreationParams {
    package: string,
    action: string,
    params?: any
}

/**
 * Represents the creation parameters for an action in the REDBTN system.
 */
export interface ActionCreationParams {
    package: string,
    condition: string,
    action: string,
    params?: any
}

/**
 * Represents the creation parameters for a persistent process in the REDBTN system.
 */
export interface PersistentCreationParams {
    package: string,
    module?: string,
    params?: any
}
