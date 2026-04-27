# Protocol Version Management Strategy

## Overview

This document outlines the strategy for supporting multiple versions of the av-controller within the AvonX platform, enabling backward compatibility while maintaining development flexibility.

## Current Architecture

### Existing Version Mechanism
- **Protocol Version**: `RootSpecification.version` (protocol/src/messages.ts:13) automatically includes `packageJson.version` (currently 0.3.4)
- **Version Transmission**: Sent during connection initialization (protocol/src/transports/window.ts:34)
- **Current Integration**: Frontend uses symlinked controller (`node_modules/av-controller -> ../../../controller`)

### Current Components
```
/protocol (av-controls v0.3.4)     - Core protocol library
/controller (av-controller v0.3.3) - Standalone controller app
/platform/frontend                 - Embeds controller via symlink
```

## Proposed Strategy: Multiple Package + Symlink Approach

### Package Configuration
```json
{
  "dependencies": {
    "av-controller": "file:../../../controller",        // symlink for latest dev
    "av-controller-0.3.2": "npm:av-controller@0.3.2",
    "av-controller-0.3.3": "npm:av-controller@0.3.3"
  }
}
```

### Version Negotiation Flow

#### 1. Artwork Declaration (Protocol-Based)
Artworks declare version compatibility via av-controls protocol initialization:

```typescript
// In artwork's av-controls setup
const controllerRequirements = {
  minVersion: "0.3.2",
  maxVersion: "0.3.4",
  preferredVersion: "0.3.3"
}

// Or using semver-style ranges
const requiredControllerVersion = "^0.3.2"
```

#### 2. Frontend Version Resolution
```typescript
// In platform/frontend
const getCompatibleController = async (artworkRequirements: string) => {
  const availableVersions = ["0.3.2", "0.3.3", "local-dev"]
  const compatibleVersion = resolveVersion(artworkRequirements, availableVersions)

  switch(compatibleVersion) {
    case "0.3.2":
      return await import("av-controller-0.3.2")
    case "0.3.3":
      return await import("av-controller-0.3.3")
    case "local-dev":
    default:
      return await import("av-controller") // symlinked latest
  }
}

// Usage in components
const Controller = await getCompatibleController(artwork.controllerRequirements)
```

#### 3. Runtime Version Handshake
```typescript
// Enhanced RootSpecification with compatibility info
export class RootSpecification implements Message {
  static type = 'controller-specification' as const;
  type = RootSpecification.type;
  version = packageJson.version;

  constructor(
    public name: string,
    public rootControlSpec: Base.Spec,
    public compatibilityInfo?: {
      supportedVersions: string[],
      minProtocolVersion: string,
      features: string[]
    }
  ) {}
}
```

### Implementation Components

#### 1. Version Resolution Utility
```typescript
// platform/frontend/src/utils/version-resolver.ts
import semver from 'semver'

interface VersionRequirement {
  range?: string;
  minVersion?: string;
  maxVersion?: string;
  preferredVersion?: string;
}

export function resolveCompatibleVersion(
  requirement: VersionRequirement,
  availableVersions: string[]
): string {
  // Implementation using semver for range matching
  // Fall back to local-dev if no compatible version found
}
```

#### 2. Controller Factory
```typescript
// platform/frontend/src/services/controller-factory.ts
export class ControllerFactory {
  private static loadedControllers = new Map<string, any>()

  static async getController(versionRequirement: string) {
    const version = resolveCompatibleVersion(versionRequirement, this.availableVersions)

    if (!this.loadedControllers.has(version)) {
      const controller = await this.importController(version)
      this.loadedControllers.set(version, controller)
    }

    return this.loadedControllers.get(version)
  }

  private static async importController(version: string) {
    // Dynamic import based on resolved version
  }
}
```

#### 3. Enhanced Transport Layer
```typescript
// protocol/src/transports/window.ts - Enhanced Receiver
export class Receiver {
  constructor(
    private otherWindow: Window,
    private name: string,
    private rootReceiver: Base.Receiver,
    private compatibilityInfo?: CompatibilityInfo // New parameter
  ) {
    // Enhanced RootSpecification with compatibility info
    this.send(new AvControlsMessages.RootSpecification(
      this.name,
      this.rootReceiver.spec,
      this.compatibilityInfo
    ));
  }
}
```

## Benefits

### ✅ Protocol Stability
- Version negotiation becomes a first-class protocol feature
- Existing `RootSpecification.version` mechanism is leveraged and enhanced
- Protocol evolution is managed systematically

### ✅ Development Workflow
- **Symlink preserved**: `av-controller` remains linked to `/controller` for active development
- **Version isolation**: Published versions don't interfere with development
- **Gradual migration**: Artworks can specify version requirements as needed

### ✅ Runtime Flexibility
- Artworks declare compatibility requirements in code (not metadata)
- Frontend dynamically selects appropriate controller version
- Graceful fallbacks to newer versions when compatible

### ✅ Backward Compatibility
- Older artworks continue working with newer controllers via protocol compatibility
- No breaking changes for existing artworks
- Version-specific bug fixes can be delivered

## Implementation Phases

### Phase 1: Foundation
1. Add version resolution utilities to frontend
2. Implement controller factory with dynamic imports
3. Add multiple controller versions to package.json

### Phase 2: Protocol Enhancement
1. Enhance `RootSpecification` with compatibility info
2. Update transport layer to handle version negotiation
3. Add version compatibility checking

### Phase 3: Integration
1. Update frontend components (Mixer.vue, SingleController.vue, NetPanel.vue)
2. Add fallback mechanisms for unsupported versions
3. Add developer tools for version debugging

### Phase 4: Documentation & Testing
1. Document version compatibility guidelines for artwork developers
2. Create test suites for multi-version scenarios
3. Add migration guides for existing artworks

## File Locations

### Core Implementation Files
- `platform/frontend/src/utils/version-resolver.ts` - Version resolution logic
- `platform/frontend/src/services/controller-factory.ts` - Controller instantiation
- `protocol/src/messages.ts` - Enhanced RootSpecification
- `protocol/src/transports/window.ts` - Enhanced transport layer

### Configuration Files
- `platform/frontend/package.json` - Multiple controller dependencies
- `platform/frontend/tsconfig.app.json` - TypeScript path mappings if needed

### Component Updates
- `platform/frontend/src/views/Mixer.vue:9`
- `platform/frontend/src/views/SingleController.vue:6`
- `platform/frontend/src/views/NetPanel.vue`

## Example Artwork Integration

```typescript
// In an artwork using av-controls
import { Transports } from 'av-controls'

// Declare controller requirements
const receiver = new Transports.Window.Receiver(
  window.parent,
  'My Artwork',
  rootReceiver,
  {
    controllerRequirements: "^0.3.2",
    supportedFeatures: ['faders', 'xyPads', 'buttons']
  }
)
```

## Migration Path for Existing Artworks

1. **No immediate changes required** - existing artworks continue using current mechanism
2. **Optional enhancement** - artworks can specify version requirements for better compatibility
3. **Gradual adoption** - new artworks benefit from version negotiation immediately

## Notes

- This strategy leverages the existing protocol infrastructure rather than requiring metadata-based solutions
- Version negotiation happens at the protocol level, keeping artwork concerns separate from platform concerns
- The approach maintains the current development workflow while adding production flexibility
- Implementation can be done incrementally without breaking existing functionality