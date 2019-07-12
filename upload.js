var Mcc = Mcc || {}

Mcc = (function($) {
  uploader = function(o) {
    options = $.extend({
      host: "https://mycityconstruction-demo.com",
      filesElement: null,         // アップロード対象のElement         
      productId: null,            // アップロード対象の工事・業務データid
      apiKey: null,               // APIキー
      folderRelativePath: "",     // 成果物のフォルダ相対パス。デフォルトではルートに設置されます。
      chunkSize: 5242880,         // 分割サイズ。AWS S3の仕様上 5MB以下での指定はできません。
      callbacks: {
        onUploadInitialized: function(id) {},         // アップロードの準備を行ったタイミングで呼ばれる
        onUploadStarted: function(id) {},             // アップロードが開始されたタイミングで呼ばれる
        onUploadCompleted: function(id) {},           // アップロードが完了したタイミングで呼ばれる
        onUploadAborted: function(id) {},             // アップロードが中止したタイミングで呼ばれる
        onUploadFailed: function(id, reason) {},      // アップロードが失敗したタイミングで呼ばれる
        onUploadFinished: function(id) {},    // アップロードの成否にかかわらず終了したタイミングで呼ばれる
        onProgress: function(id, current, total) {},  // アップロードの進捗が進んだタイミングで呼ばれる
      }
    }, o);
    states = [];  // アップロード状況リスト
    handlers = [] // ファイルハンドラリスト
    files = options.filesElement[0].files;
    // フォルダ内のファイルをアップロード
    for (var i = 0; i < files.length; i++) {
      // ファイルハンドラにはidとnameの2つのプロパティがあります。
      // idはアップロードされるファイルに一意に振られる番号で、以降の処理でアップロード等をなどを行う際に指定するidです。
      // nameはアップロードされる(相対パスも含む)ファイル名です。
      handlers[i] = {id: i, name: files[i].webkitRelativePath}
      // 状況にはabortとcompleteの2つのプロパティがあります。
      // アップロードを中止するとabortがtrueになり
      // アップロードが完了するとcompleteがtrueになります。
      states[i] = {abort: false, complete: false}
    }

    /**
     * ファイルハンドラのリストを取得する
     */
    getHandlers = function() {
      return handlers;
    }

    /**
     * ファイルハンドラidからアップロード状態を取得する
     * @param id ファイルハンドラid
     */
    getState = function(id) {
      if (!states[id]) return null;
      state = states[id];
      return {abort: state.abort, complete: state.complete};
    } 

    /**
     * ファイルハンドラidからファイルを取得する
     * @param id ファイルハンドラid
     */
    getFile = function(id) {
      if (!files[id]) return null;
      return files[id];
    }

    /**
     * ファイルハンドラidを指定してアップロードを中止する
     * @param id ファイルハンドラid
     */
    abortUpload = function(id) {
      if (!states[id]) return;
      // すでに中止されておらず、完了もしていない場合、中止できる
      if (states[id].abort  == false && states[id].complete == false) {
        states[id].abort = true;
        if (options.callbacks.onUploadAborted) {
          options.callbacks.onUploadAborted(id);
        }
      }
    }

    /**
     * ファイルハンドラidを指定してアップロードする
     * @param id ファイルハンドラid
     */
    upload = function(id) {
      var file = getFile(id);
      if (!file) {
        console.error("\'" + id + "\'というファイルハンドラは存在しません。")
      }
      var etags = {};
      var uploadId = null;

      // アップロード初期化前にすでに中止状態であれば終了
      if (states[id].abort) {
        // 終了をコールバック
        if (options.callbacks.onUploadFinished) {
          options.callbacks.onUploadFinished(id);
        }
        return;
      }

      // 初期化をコールバック
      if (options.callbacks.onUploadInitialized) {
        options.callbacks.onUploadInitialized(id);
      }
      // アップロード
      return initialize(file.webkitRelativePath)
        .then(function(data){
          // 開始をコールバック
          if (options.callbacks.onUploadStarted) {
            options.callbacks.onUploadStarted(id);
          }
          // アップロードidを取得後、分割アップロード
          uploadId = $(data).find('UploadId').text();
          return parts(file.webkitRelativePath, id, 1, file, 0, etags, uploadId, states[id]);
        })
        .then(function(){
          // 完了をMyCityConstructionに伝える
          return complete(file.webkitRelativePath);
        })
        .then(function() {
          // 完了をコールバック
          states[id].complete = true;
          if (options.callbacks.onUploadCompleted) {
            options.callbacks.onUploadCompleted(id);
          }
          return Promise.resolve();
        })
        .catch(function(data) {
          if (data == 'aborted'){ 
            // アップロードを中止させる
            return abort(file.webkitRelativePath, uploadId);
          }
          // 中止以外の事象でエラーが発生した場合、失敗をコールバック
          if (options.callbacks.onUploadFailed) {
            options.callbacks.onUploadFailed(id, data);
          }
          return Promise.resolve();
        })
        .then(function() {
          if (options.callbacks.onUploadFinished) {
            options.callbacks.onUploadFinished(id);
          }
          return Promise.resolve();
        })
    }

    /**
     * 分割アップロードを複数行う
     * ファイルを設定されたチャンクに分割し、アップロードを行う
     * アップロード完了後、マージを行う
     * @param path ファイルのアップロード先のパス
     * @param id ファイルハンドラid
     * @param current 分割番号
     * @param file ファイル
     * @param readBytes ファイルアップロード済バイト数
     * @param etags 結合に必要なEtagヘッダの配列
     * @param uploadId アップロードid
     * @param state アップロードの状況
     */
    parts = function(path, id, current, file, readBytes, etags, uploadId, state) {
      // ファイルを分割
      var chunk = file.slice(readBytes, readBytes + options.chunkSize);
      readBytes += options.chunkSize;
      
      return part(path, chunk, current, uploadId, state)
        .then(function(data, status, xhr){
          if (state.abort) return Promise.reject();

          // 分割アップロード成功後は、結合するために分割番号とETagを記録
          etags[current] = xhr.getResponseHeader('ETag');
          if (readBytes >= file.size){
            if (options.callbacks.onProgress) {
              options.callbacks.onProgress(id, file.size, file.size);
            }
            // ETagのリストを使ってマージ
            return merge(file.webkitRelativePath, etags, uploadId, state);
          }
          current++;
          if (options.callbacks.onProgress) {
            options.callbacks.onProgress(id, readBytes, file.size);
          }
          return parts(path, id, current, file, readBytes, etags, uploadId, state);
        });
    }

    /**
     * アップロードの開始
     * @param path ファイルのアップロード先のパス
     */
    initialize = function(path) {
      var url = options.host + '/api/v1/products/' + options.productId + '/uploads/initialize/' + options.folderRelativePath + path;
      return $.ajax({
        type: "GET",
        url: url,
        dataType: 'json',
        headers: { 'X-Mcc-Api-Key': options.apiKey }
      })
      .then(function(data){
        return $.ajax({
          type: "POST",
          url: data.url,
          contentType: false,
          processData: false,
          contentData: false,
        });
      });
    }

    /**
     * 分割アップロード
     * @param path ファイルのアップロード先のパス
     * @param partFile 分割されたファイル
     * @param partNumber 分割番号
     * @param uploadId アップロードid
     * @param state アップロードの状況
     */
    part = function(path, partFile, partNumber, uploadId, state) {
      var url = options.host + '/api/v1/products/' + options.productId + '/uploads/part/' + options.folderRelativePath + path + '?part_number='+ partNumber +'&upload_id=' + uploadId;
      if (state.abort) return Promise.reject('aborted');
      return $.ajax({
        type: "GET",
        url: url,
        dataType: 'json',
        headers: { 'X-Mcc-Api-Key': options.apiKey }
      })
      .then(function(data){
        if (state.abort) return Promise.reject('aborted');
        return $.ajax({
          type: "PUT",
          url: data.url,
          data: partFile,
          contentType: false,
          processData: false,
          contentData: false,
        });
      });
    }
    
    /**
     * アップロードの結合
     * @param path ファイルのアップロード先のパス
     * @param etags 結合に必要なEtagヘッダの配列
     * @param uploadId アップロードid
     * @param state アップロードの状況
     */
    merge = function(path, etags, uploadId, state) {
      var url = options.host + '/api/v1/products/' +  options.productId + '/uploads/merge/' + options.folderRelativePath + path + '?upload_id=' + uploadId;
      if (state.abort) return Promise.reject('aborted');
      return $.ajax({
        type: "GET",
        url: url,
        dataType: 'json',
        headers: { 'X-Mcc-Api-Key': options.apiKey }
      })
      .then(function(data){
        if (state.abort) return Promise.reject('aborted');
        var xmlString = '<CompleteMultipartUpload>';
        for(number in etags){
          xmlString += '<Part>';
          xmlString += '<PartNumber>' + number + '</PartNumber>';
          xmlString += '<ETag>' + etags[number] + '</ETag>';
          xmlString += '</Part>';
        }
        xmlString += '</CompleteMultipartUpload>';
        return $.ajax({
          type: "POST",
          url: data.url,
          data: xmlString,
          contentType: false,
          processData: false,
          contentData: false,
        });
      });
    }

    /**
     * アップロードの中止
     * @param path ファイルのアップロード先のパス
     * @param uploadId アップロードid
     */
    abort = function(path, uploadId) {
      var url = options.host + '/api/v1/products/' + options.productId + '/uploads/abort/' + options.folderRelativePath + path + '?upload_id=' + uploadId;
      return $.ajax({
        type: "GET",
        url: url,
        dataType: 'json',
        headers: { 'X-Mcc-Api-Key': options.apiKey }
      })
      .then(function(data){
        return $.ajax({
          type: "DELETE",
          url: data.url,
          contentType: false,
          processData: false,
          contentData: false,
        });
      })
    }

    /**
     * アップロードの登録
     * @param path ファイルのアップロード先のパス
     */
    complete = function(path) {
      var url = options.host + '/api/v1/products/' + options.productId + '/uploads/register/' + options.folderRelativePath + path;
      return $.ajax({
        type: "POST",
        url: url,
        dataType: 'json',
        headers: { 'X-Mcc-Api-Key': options.apiKey }
      });
    }

    return {
      getHandlers: getHandlers,
      getFile: getFile,
      getState: getState,
      upload: upload,
      abortUpload: abortUpload,
    }
  }
  return {
    uploader: uploader
  }
}(jQuery));