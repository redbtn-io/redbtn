# REDBTN Automation System

REDBTN is a flexible and dynamic automation system designed to manage and execute automations within applications and simplify the process for creating interopability between those applications. 

This system allows for the seamless integration of various automation processes, making it adaptable to a wide range of application needs. 

It requires no dependencies, and dynamically imports "connectors" to load data from APIs, analyze that data, and interact with those APIs based on that analysis.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Starting the System](#starting-the-system)
  - [Stopping the System](#stopping-the-system)
  - [Adding an Automation](#adding-an-automation)
  - [Removing an Automation](#removing-an-automation)
  - [Editing an Automation](#editing-an-automation)
  - [Setting Options](#setting-options)
  - [Setting Data](#setting-data)
  - [Setting Listeners and Finishers](#setting-listeners-and-finishers)
  - [Getting Status and Automations](#getting-status-and-automations)
- [Interfaces](#interfaces)
- [License](#license)

## Installation

To install the REDBTN system, use npm:

```sh
npm install redbtn
```

## Usage

### Starting the System

To start the REDBTN system with specific options:

```typescript
import { start } from 'redbtn';

await start({ freq: 1000 });
```

### Stopping the System

To stop the REDBTN system:

```typescript
import { stop } from 'redbtn';

await stop();
```

### Adding an Automation

To add a new automation:

```typescript
import { add } from 'redbtn';

await add({
  name: "Sample Automation",
  triggers: [
    { package: "triggerPackage", action: "triggerAction", params: {} }
  ],
  actions: [
    { package: "actionPackage", condition: "t", action: "actionMethod", params: {} }
  ]
});
```

### Removing an Automation

To remove an existing automation:

```typescript
import { remove } from 'redbtn';

await remove('automation-id');
```

### Editing an Automation

To edit an existing automation:

```typescript
import { edit } from 'redbtn';

await edit('automation-id', {
  name: "Updated Automation",
  actions: [
    { package: "newActionPackage", condition: "t", action: "newActionMethod", params: {} }
  ]
});
```

### Setting Options

To set options for the REDBTN system:

```typescript
import { setOptions } from 'redbtn';

await setOptions({ freq: 2000 });
```

### Setting Data

To set data for the REDBTN system:

```typescript
import { set } from 'redbtn';

await set({ key: "value" });
```

### Setting Listeners and Finishers

To set a listener function:

```typescript
import { listen } from 'redbtn';

await listen((id, results) => {
  console.log(`Automation ${id} executed with results:`, results);
});
```

To set a finisher function:

```typescript
import { finish } from 'redbtn';

await finish(() => {
  console.log('REDBTN system finished execution.');
});
```

### Getting Status and Automations

To get the current status of the REDBTN system:

```typescript
import { status } from 'redbtn';

console.log(status());
```

To get all automations in the REDBTN system:

```typescript
import { automations } from 'redbtn';

console.log(automations());
```

To get a specific automation by ID:

```typescript
import { automation } from 'redbtn';

console.log(automation('automation-id'));
```

## Interfaces

### REDBTN

The main interface representing the REDBTN system:

```typescript
interface REDBTN {
  options: Options;
  automations: Automations;
  interval?: NodeJS.Timeout;
  data: any;
  listener?: Function;
  finisher?: Function;
  active: boolean;
}
```

### Automation

Represents an automation in the REDBTN system:

```typescript
interface Automation {
  name: string;
  id: string;
  loaders?: Loader[];
  triggers?: Trigger[];
  actions?: Action[];
  persistent?: Persistent;
}
```

### Options

Represents the set of options for the REDBTN system:

```typescript
interface Options {
  freq: number;
  [name: string]: string | number | boolean;
}
```

### Loader, Trigger, Action, Persistent

Interfaces for loaders, triggers, actions, and persistent processes:

```typescript
interface Loader {
  package: string;
  action: string;
  params: any;
  connector: any;
}

interface Trigger {
  package: string;
  action: string;
  params: any;
  connector: any;
}

interface Action {
  package: string;
  condition: string;
  action: string;
  params: any;
  connector: any;
}

interface Persistent {
  package: string;
  module?: string;
  params: any;
  connector?: any;
  process?: any;
}
```

### AutomationCreationParams

Parameters for creating an automation:

```typescript
interface AutomationCreationParams {
  name: string;
  id?: string;
  loaders?: LoaderCreationParams[];
  triggers?: TriggerCreationParams[];
  actions?: ActionCreationParams[];
  persistent?: PersistentCreationParams;
}
```

### LoaderCreationParams, TriggerCreationParams, ActionCreationParams, PersistentCreationParams

Creation parameters for loaders, triggers, actions, and persistent processes:

```typescript
interface LoaderCreationParams {
  package: string;
  action: string;
  params?: any;
}

interface TriggerCreationParams {
  package: string;
  action: string;
  params?: any;
}

interface ActionCreationParams {
  package: string;
  condition: string;
  action: string;
  params?: any;
}

interface PersistentCreationParams {
  package: string;
  module?: string;
  params?: any;
}
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.