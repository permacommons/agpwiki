import { defineModel, defineStaticMethods } from '../../dal/lib/create-model.js';
import blogPostManifest, { type BlogPostModel } from './manifests/blog-post.js';

const blogPostStaticMethods = defineStaticMethods(blogPostManifest, {
  async getBySlug(this: BlogPostModel, slug: string) {
    return this.filterWhere({ slug }).first();
  },
});

export default defineModel(blogPostManifest, { staticMethods: blogPostStaticMethods });
