/**
 * Tool Platform Test Script
 * Demonstrates how to use the unified tool registry
 */

const { getUnifiedRegistry } = require('./src/agent-sdk/registry/UnifiedRegistry');
const { getToolManager } = require('./src/agent-sdk/tools');

async function testTools() {
  console.log('🚀 Testing Multi-Agent Tool Platform\n');

  // Initialize tool manager
  const toolManager = getToolManager();
  await toolManager.initialize();

  // Get registry
  const registry = getUnifiedRegistry();

  // Show all registered tools
  console.log('📋 Registered Tools:');
  console.log('===================');
  
  const tools = registry.getAllTools();
  const categories = registry.getCategories();
  
  categories.forEach(category => {
    const catTools = tools.filter(t => t.category === category);
    if (catTools.length > 0) {
      console.log(`\n${category.toUpperCase()} (${catTools.length}):`);
      catTools.forEach(tool => {
        console.log(`  • ${tool.id} - ${tool.name}`);
      });
    }
  });

  // Show skills (admin view)
  console.log('\n\n🎯 Skills (Admin View):');
  console.log('======================');
  
  const skills = registry.getAllSkills();
  skills.slice(0, 5).forEach(skill => {
    console.log(`\n${skill.name} (${skill.category})`);
    console.log(`  Enabled: ${skill.enabled}`);
    console.log(`  Triggers: ${skill.triggerPatterns?.join(', ')}`);
  });

  // Show frontend tools
  console.log('\n\n🌐 Frontend Tools:');
  console.log('=================');
  
  const frontendTools = registry.getFrontendTools();
  frontendTools.forEach(tool => {
    console.log(`\n${tool.name}`);
    console.log(`  Icon: ${tool.icon}`);
    console.log(`  Category: ${tool.category}`);
    console.log(`  Available: ${tool.isAvailable}`);
  });

  // Show statistics
  console.log('\n\n📊 Statistics:');
  console.log('=============');
  
  const stats = toolManager.getStats();
  console.log(`Total Tools: ${stats.tools}`);
  console.log(`Total Skills: ${stats.skills}`);
  console.log(`Categories: ${stats.categories.join(', ')}`);
  
  console.log('\nBy Category:');
  stats.byCategory.forEach(cat => {
    console.log(`  ${cat.name}: ${cat.count}`);
  });

  console.log('\nTool readiness:');
  toolManager.getToolReadinessSummary().forEach(readiness => {
    console.log(`  ${readiness.toolId}: ${readiness.status} (${readiness.executableShape})`);
  });

  // Test executing a tool
  console.log('\n\n⚡ Testing Tool Execution:');
  console.log('=========================');
  
  try {
    const webFetch = toolManager.getTool('web-fetch');
    if (webFetch) {
      console.log('\nExecuting web-fetch...');
      const result = await toolManager.executeTool('web-fetch', {
        url: 'https://api.github.com',
        method: 'GET',
        timeout: 10000
      });
      
      console.log(`Success: ${result.success}`);
      console.log(`Status: ${result.data?.status}`);
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
      console.log(`Duration: ${result.duration}ms`);
    }
  } catch (error) {
    console.log(`Execution test skipped: ${error.message}`);
  }

  console.log('\n✅ Tool Platform Test Complete!');
}

// Run if called directly
if (require.main === module) {
  testTools().catch(console.error);
}

module.exports = { testTools };
