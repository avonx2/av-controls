# AV-Controller Project Guidelines

## Build Commands
- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run type-check` - Run TypeScript type checking

## Code Style
- **Framework**: Vue 3 with Composition API and TypeScript
- **Formatting**: 2-space indentation
- **Naming**: PascalCase for components, camelCase for variables/functions, kebab-case for CSS classes
- **Components**: Use Single File Components (.vue) with `<script setup lang="ts">`, explicit prop types
- **Imports**: Include file extensions (`.vue`) for component imports
- **Types**: Use strict TypeScript typing, prefer interfaces for object shapes
- **State Management**: Use Vue's Composition API (ref, computed, etc.)
- **CSS**: Use scoped styles with `<style scoped>` in components

## Project Structure
- `/src/components` - Vue components organized by feature
- `/src/assets` - Static assets and global styles
- `/public` - Public static files
