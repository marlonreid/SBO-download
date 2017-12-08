chrome.browserAction.onClicked.addListener((tab) => {
  let downloadBook = new DownloadBook(tab.url)
  downloadBook.run()
})

class DownloadBook {
  constructor(url) {
    this.bookId = this.getBookId(url)
    this.bookTitle = this.bookId;
    this.baseUrl = "https://www.safaribooksonline.com";
    this.books = {};
  }

  // downloads the book
  async run() {
    try {
      var book = await this.createBook(this.bookId);
      return await this.downloadFile(book);
    } catch (error) {
      console.log("ERROR: " + error);
    }
  }

  downloadFile(book) {
    let filename = this.bookTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()
    let url = window.URL.createObjectURL(book)
    let link = document.createElement('a')
    link.download = filename + '.epub'
    link.href = url
    link.click()
    window.URL.revokeObjectURL(url)
  }

  async createBook(id) {
    let zip = new JSZip()

    console.log(`getBookById called with id: ${id}`);
    if (!id) {
      return Promise.reject("id was not specified");
    }

    var book = new Object();
    var metadata = await this.getMetadata(id);

    book.title = metadata.title;
    this.bookTitle = book.title;
    book.uuid = metadata.identifier;
    book.language = metadata.language;
    book.author = metadata.authors.map((json) => {
      return json.name;
    });
    book.cover = metadata.cover;
    book.description = metadata.description;
    book.publisher = metadata.publishers.map((json) => {
      return json.name;
    });

    book.chapters = await this.getChapters(metadata.chapters);
    book.stylesheet = await this.getStylesheetUrl(book.chapters);
    console.log(book);

    // mimetype
    zip.file("mimetype", "application/epub+zip");

    // metadata
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="UTF-8" ?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
    </container>`);

    // Do the cover
    var coverResponse = await this.fetchResource(book.cover, { uri: book.cover, json: false });
    var coverContents = await coverResponse.blob();
    zip.file("OEBPS/images/cover.jpg", coverContents);

    // Stylesheet it
    zip.file("OEBPS/core.css", book.stylesheet);

    // Do the chapters
    var imagesForChapter = [];
    for (var i = 0; i < book.chapters.length; ++i) {
      var chapter = book.chapters[i];

      // Get the images for the chapter

      for (var j = 0; j < chapter.images.length; ++j) {
        var image = chapter.images[j];
        let pathArray = image.split('/');
        var newLocation = image;
        if (pathArray.length > 1) {
          newLocation = pathArray[pathArray.length - 1];
        }
        imagesForChapter.push({ baseUrl: chapter.asset_base_url, file: image, media: "image/jpg", path: newLocation });

        var imageUrl = chapter.asset_base_url + image;
        this.fetchResource(imageUrl, { uri: imageUrl, json: false }).then((imageResponse) => {
          imageResponse.blob().then((imagedata) => { zip.file("OEBPS/images/" + newLocation, imagedata) });
        });
      }

      // Get the actual chapter contents
      var chapterContentResponse = await this.fetchResource(chapter.content, { uri: chapter.content, json: false });
      var contents = await chapterContentResponse.text();

      // Link up the images to the chapter contents
      chapter.images.forEach((image) => {
        var re = new RegExp(`"[^"]*${image}"`, 'g');
        let pathArray = image.split('/');
        var newLocation = image;
        if (pathArray.length > 1) {
          newLocation = pathArray[pathArray.length - 1];
        }
        contents = contents.replace(re, `"images/${newLocation}"`);
      });

      // Add css
      var coreCSS = "";
      if (book.stylesheet) {
        coreCSS = `<link type="text/css" rel="stylesheet" media="all" href="core.css" />`;
      }
      // ## purify html
      contents = this.purifyHTML(contents);
      var contentsEjs = new EJS({ url: '/oebps.ejs' })
      const fileContent = contentsEjs.render({ title: chapter.title, coreCSS, contents })
      zip.file("OEBPS/" + chapter.filename, fileContent);

    }

    // Used for OPF
    book.imagesToFetch = imagesForChapter;

    // Create OPF
    var contentEjs = new EJS({ url: '/content.opf.ejs' })
    var opfData = contentEjs.render(book)
    zip.file("OEBPS/content.opf", opfData);

    // Create TOC
    var tocEjs = new EJS({ url: '/toc.ncx.ejs' })
    var toc = tocEjs.render(book);
    zip.file("OEBPS/toc.ncx", toc);

    // Create style
    var styleEjs = new EJS({ url: '/style.css.ejs' });
    var style = styleEjs.render(book);
    zip.file("OEBPS/style.css", style);

    return zip.generateAsync({ type: 'blob' })
  }

  purifyHTML(string) {
    // area,base,basefont,br,col,frame,hr,img,input,isindex,keygen,link,meta,menuitem,source,track,param,embed,wbr
    // <(\s?img[^>]*[^\/])>
    ["img"].forEach((tag) => {
      var re = new RegExp("<(\s?" + tag + "[^>]*[^\/])>", 'g');
      string = string.replace(re, "<$1 />");
    });
    ["br", "hr"].forEach((tag) => {
      var re = new RegExp("<\s?" + tag + "[^>]*>", "g");
      string = string.replace(re, `<${tag}/>`);
    });
    return string;
  }


  getBookId(url) {
    let match = url.match(/\/library\/view\/[^\/]+\/(\w+)\//)
    let bookId = match && match[1]

    if (!bookId) {
      throw new Error('could not extract book id from url')
    }

    return bookId;
  }

  async getMetadata(id) {
    return await this.fetchResource(`api/v1/book/${id}/`);
  }

  async getStylesheetUrl(chapters) {
    var cssSet = new Set();
    chapters.forEach((chapter) => {
      chapter["stylesheets"].forEach((style) => {
        cssSet.add(style.url);
      });
    });
    var stylesheetUrl;
    if (cssSet.size > 1) {
      console.log(`an error occurred while fetching stylesheets. there are ${cssSet.size} different stylesheets. Taking the first one.`);
    }

    stylesheetUrl = Array.from(cssSet)[0];
    var stylesheetResponse = await this.fetchResource(stylesheetUrl, { uri: stylesheetUrl, json: false });
    var stylesheet = await stylesheetResponse.text();
    console.log(`stylesheet retrieved: ${stylesheetUrl}`);
    return Promise.resolve(stylesheet);
  }

  async getTOC(id) {
    var body = await this.fetchResource(`/api/v1/book/${id}/flat-toc/`);
    if (!this.books[id]) this.books[id] = {};
    var toc = {};
    body.forEach((chapToc) => {
      toc[chapToc.url] = chapToc;
    });

    return Promise.resolve(toc);
  }


  createThrottle(max) {
    if (typeof max !== 'number') {
      throw new TypeError('`createThrottle` expects a valid Number')
    }

    let cur = 0
    const queue = []
    function throttle(fn) {
      return new Promise((resolve, reject) => {
        function handleFn() {
          if (cur < max) {
            throttle.current = ++cur
            fn()
              .then(val => {
                resolve(val)
                throttle.current = --cur
                if (queue.length > 0) {
                  queue.shift()()
                }
              })
              .catch(err => {
                reject(err)
                throttle.current = --cur
                if (queue.length > 0) {
                  queue.shift()()
                }
              })
          } else {
            queue.push(handleFn)
          }
        }

        handleFn()
      })
    }

    // keep copies of the "state" for retrospection
    throttle.current = cur
    throttle.queue = queue
    return throttle
  }

  async getChapters(chapters) {
    var toc = await this.getTOC(this.bookId);
    const throttle = this.createThrottle(3)
    let promises = chapters.map((chapterUrl) => throttle(async () => {
      return this.fetchResource(chapterUrl, { uri: chapterUrl }).then((chapterMeta) => {
        if (!chapterMeta.content) {
          return Promise.reject("the books 'content' key is missing from the response.");
        }
        // ### chapter meta fetched successfully
        // ### fetch chapter content for now
        return this.fetchResource(chapterMeta.content, { uri: chapterMeta.content, json: false }).then(async (chapterContentResponse) => {
          var chapterContent = await chapterContentResponse.text();
          chapterMeta["added_chapter_content"] = chapterContent;
          let chapToc = toc[chapterMeta.url];
          // ## ignore if it is not part of the toc file; will not be added to the content
          if (chapToc) {
            chapterMeta["added_order"] = chapToc.order;
            chapterMeta["added_id"] = chapToc.id;
          } else {
            // ## it must be a TOC file, add order 0 and id tocxhtml
            chapterMeta["added_order"] = 0;
            chapterMeta["added_id"] = "tocxhtmlfile";
          }
          return Promise.resolve(chapterMeta);
        });
      });
    }))

    return Promise.all(promises).then((body) => {
      console.log('successfully fetched all the chapters content');
      return Promise.resolve(body);
    });
  }

  async getBookDetails(id) {
    console.log(`getBookById called with id: ${id}`);
    if (!id) return Promise.reject("id was not specified");

    if (!this.books[id]) this.books[id] = {};

    this.books[id].meta = await this.getMetadata(id);
    this.books[id].toc = await this.getTOC(id);
    await this.getChapters(id);
    await this.getStylesheet(id);

    if (!this.books[id]) return Promise.reject("the book you requested was not fetched yet");
    let book = this.books[id];
    if (!book.meta || !book.chapters) return Promise.reject("the book you requested is missing some required information");
    let jsonBook = {
      "title": book.meta.title,
      "uuid": book.meta.identifier,
      "language": book.meta.language,
      "author": book.meta.authors.map((json) => {
        return json.name;
      }),
      "cover": book.meta.cover,
      "description": book.meta.description,
      "publisher": book.meta.publishers.map((json) => {
        return json.name;
      }),
      "stylesheet": book.stylesheet,
      "chapters": book.chapters.map((chapter) => {
        return {
          "fileName": chapter.filename,
          "assetBase": chapter["asset_base_url"],
          "images": chapter["images"],
          "title": chapter.title,
          "content": chapter["added_chapter_content"],
          "id": chapter["added_id"],
          "order": chapter["added_order"]
        };
      })
    }
    return Promise.resolve(jsonBook);
  }

  fetchResource(url, options) {
    if (!url) return Promise.reject("url was not specified");
    // ## prepare options for resource request
    var uri = `${this.baseUrl}/${url}`;
    var json = true;
    if (options && options.json == false) json = false;
    if (options && options.uri) uri = options.uri;
    console.log(`fetchResource called with URL: ${uri}`);
    // ## make request
    return fetch(uri, {
      credentials: 'include'
    }).then((body) => {
      if (json == true) {
        return body.json();
      }
      return Promise.resolve(body);
    }).catch((err) => {
      // ### an error occurred
      console.log(`there was an unexpected error fetching the resource (err: ${err})`)
      return Promise.reject(err);
    });
  }
}
