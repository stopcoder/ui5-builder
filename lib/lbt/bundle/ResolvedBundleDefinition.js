"use strict";

const UI5ClientConstants = require("../UI5ClientConstants");
const ModuleInfo = require("../resources/ModuleInfo");
const {SectionType} = require("./BundleDefinition");

class ResolvedBundleDefinition {
	constructor( bundleDefinition /* , vars*/) {
		this.bundleDefinition = bundleDefinition;
		this.name = bundleDefinition.name;
		// NODE-TODO (ModuleName) ModuleNamePattern.resolvePlaceholders(bundleDefinition.getName(), vars);
		this.sections = bundleDefinition.sections.map(
			(sectionDefinition) => new ResolvedSection(this, sectionDefinition)
		);
	}

	get containsCore() {
		return this.sections.some(
			(section) =>
				(section.mode === SectionType.Raw || section.mode === SectionType.Require)
				&& section.modules.some((module) => module === UI5ClientConstants.MODULE__SAP_UI_CORE_CORE)
		);
	}

	get containsGlobal() {
		return this.sections.some(
			(section) =>
				section.mode === SectionType.Raw
				&& section.modules.some((module) => module === UI5ClientConstants.MODULE__JQUERY_SAP_GLOBAL)
		);
	}

	executes(moduleName) {
		return this.sections.some(
			(section) =>
				(section.mode === SectionType.Raw || section.mode === SectionType.Require)
				&& section.modules.some((module) => module === moduleName)
		);
	}

	createModuleInfo(pool) {
		let bundleInfo = new ModuleInfo();
		bundleInfo.name = this.name;

		let promise = Promise.resolve(true);
		this.sections.forEach( (section) => {
			promise = promise.then( () => {
				if ( section.mode === SectionType.Provided ) {
					return;
				}
				if ( section.mode === SectionType.Require ) {
					section.modules.forEach( (module) => bundleInfo.addDependency(module) );
					return;
				}
				if ( section.mode == SectionType.Raw && section.modules.length ) {
					// if a bundle contains raw modules, it is a raw module itself
					bundleInfo.rawModule = true;
				}
				let modules = section.modules;
				if ( section.mode === SectionType.Preload ) {
					modules = section.modules.slice();
					modules.sort();
				}

				return Promise.all(
					modules.map( (submodule) => {
						return pool.getModuleInfo(submodule).then(
							(subinfo) => bundleInfo.addSubModule(subinfo)
						);
					})
				);
			});
		});

		return promise.then( () => bundleInfo );
	}

/*
		public JSModuleDefinition getDefinition() {
			return moduleDefinition;
		}

		public Configuration getConfiguration() {
			return moduleDefinition.getConfiguration();
		}


	}
	*/
}

class ResolvedSection {
	constructor(bundle, sectionDefinition) {
		this.bundle = bundle;
		this.sectionDefinition = sectionDefinition;
	}

	get mode() {
		return this.sectionDefinition.mode;
	}

	/*
	public String getSectionName() {
		return sectionDefinition.getSectionName();
	}

	public boolean isDeclareRawModules() {
		return sectionDefinition.isDeclareRawModules();
	}

	*/
}

module.exports = ResolvedBundleDefinition;
