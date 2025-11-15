#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Home Assistant MCP Server
 * 
 * Provides:
 * 1. Command patterns as MCP resources for precheck node
 * 2. Tools for executing home automation commands
 * 3. Pattern metadata (regex, parameter extraction, confidence)
 */

// Mock Home Assistant state (in production, this would connect to real HA API)
interface DeviceState {
  entity_id: string;
  state: 'on' | 'off' | string;
  attributes: {
    friendly_name: string;
    brightness?: number;
    [key: string]: any;
  };
}

const mockDevices: Record<string, DeviceState> = {
  'light.basement': {
    entity_id: 'light.basement',
    state: 'off',
    attributes: { friendly_name: 'Basement Lights', brightness: 0 }
  },
  'light.kitchen': {
    entity_id: 'light.kitchen',
    state: 'off',
    attributes: { friendly_name: 'Kitchen Lights', brightness: 0 }
  },
  'light.bedroom': {
    entity_id: 'light.bedroom',
    state: 'off',
    attributes: { friendly_name: 'Bedroom Lights', brightness: 0 }
  },
  'lock.front_door': {
    entity_id: 'lock.front_door',
    state: 'locked',
    attributes: { friendly_name: 'Front Door' }
  }
};

/**
 * Command patterns that precheck can use
 * Format: { pattern, tool, description, examples }
 */
const commandPatterns = [
  {
    id: 'light_onoff',
    pattern: '^turn\\s+(on|off)\\s+(?:the\\s+)?(.+?)\\s+lights?$',
    flags: 'i',
    tool: 'control_light',
    description: 'Turn lights on or off',
    parameterMapping: {
      action: 1,  // Capture group 1
      location: 2  // Capture group 2
    },
    examples: [
      'turn on the basement lights',
      'turn off kitchen light',
      'turn on bedroom lights'
    ],
    confidence: 0.95
  },
  {
    id: 'light_brightness',
    pattern: '^(?:set|dim)\\s+(?:the\\s+)?(.+?)\\s+lights?\\s+to\\s+(\\d+)%?$',
    flags: 'i',
    tool: 'set_brightness',
    description: 'Set light brightness',
    parameterMapping: {
      location: 1,
      brightness: 2
    },
    examples: [
      'set basement lights to 50%',
      'dim kitchen light to 30'
    ],
    confidence: 0.9
  },
  {
    id: 'lock_control',
    pattern: '^(lock|unlock)\\s+(?:the\\s+)?(.+?)(?:\\s+door)?$',
    flags: 'i',
    tool: 'control_lock',
    description: 'Lock or unlock doors',
    parameterMapping: {
      action: 1,
      location: 2
    },
    examples: [
      'lock the front door',
      'unlock front door'
    ],
    confidence: 0.95
  }
];

const server = new Server(
  {
    name: 'home-assistant',
    version: '0.0.1',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// Expose command patterns as resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: 'pattern://home-assistant/commands',
        name: 'Home Assistant Command Patterns',
        description: 'Regex patterns for voice command detection',
        mimeType: 'application/json'
      }
    ]
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === 'pattern://home-assistant/commands') {
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: 'application/json',
        text: JSON.stringify(commandPatterns, null, 2)
      }]
    };
  }
  
  throw new Error(`Unknown resource: ${request.params.uri}`);
});

// Expose tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'control_light',
        description: 'Turn lights on or off',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'Light location (basement, kitchen, bedroom, etc.)'
            },
            action: {
              type: 'string',
              enum: ['on', 'off'],
              description: 'Turn on or off'
            }
          },
          required: ['location', 'action']
        }
      },
      {
        name: 'set_brightness',
        description: 'Set light brightness level',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'Light location'
            },
            brightness: {
              type: 'number',
              description: 'Brightness level (0-100)',
              minimum: 0,
              maximum: 100
            }
          },
          required: ['location', 'brightness']
        }
      },
      {
        name: 'control_lock',
        description: 'Lock or unlock doors',
        inputSchema: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'Door location (front, back, garage, etc.)'
            },
            action: {
              type: 'string',
              enum: ['lock', 'unlock'],
              description: 'Lock or unlock'
            }
          },
          required: ['location', 'action']
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'control_light') {
    const { location, action } = args as { location: string; action: 'on' | 'off' };
    const entityId = `light.${location.toLowerCase().replace(/\s+/g, '_')}`;
    
    if (mockDevices[entityId]) {
      mockDevices[entityId].state = action;
      if (action === 'off') {
        mockDevices[entityId].attributes.brightness = 0;
      } else {
        mockDevices[entityId].attributes.brightness = 100;
      }
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `${mockDevices[entityId].attributes.friendly_name} turned ${action}`,
            entity_id: entityId,
            new_state: action
          })
        }]
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: `Light not found: ${location}`
        })
      }],
      isError: true
    };
  }

  if (name === 'set_brightness') {
    const { location, brightness } = args as { location: string; brightness: number };
    const entityId = `light.${location.toLowerCase().replace(/\s+/g, '_')}`;
    
    if (mockDevices[entityId]) {
      mockDevices[entityId].state = brightness > 0 ? 'on' : 'off';
      mockDevices[entityId].attributes.brightness = brightness;
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `${mockDevices[entityId].attributes.friendly_name} brightness set to ${brightness}%`,
            entity_id: entityId,
            brightness
          })
        }]
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: `Light not found: ${location}`
        })
      }],
      isError: true
    };
  }

  if (name === 'control_lock') {
    const { location, action } = args as { location: string; action: 'lock' | 'unlock' };
    const entityId = `lock.${location.toLowerCase().replace(/\s+/g, '_')}`;
    
    if (mockDevices[entityId]) {
      mockDevices[entityId].state = action === 'lock' ? 'locked' : 'unlocked';
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `${mockDevices[entityId].attributes.friendly_name} ${action}ed`,
            entity_id: entityId,
            new_state: mockDevices[entityId].state
          })
        }]
      };
    }
    
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: false,
          error: `Lock not found: ${location}`
        })
      }],
      isError: true
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Home Assistant MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
